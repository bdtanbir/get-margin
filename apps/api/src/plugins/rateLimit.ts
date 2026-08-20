import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isJobType, type JobType } from '@margin/shared'

/** How many requests, over how long. */
export type Budget = { limit: number; windowMs: number }

const MINUTE = 60_000

/**
 * What each conversion is allowed to cost.
 *
 * The budgets differ by type because the COSTS differ by an order of
 * magnitude: an HTML render is under a second, an OCR pass is minutes. One
 * shared budget would either starve the cheap conversions or hand out the
 * expensive ones for free.
 *
 * Only the types that exist appear here. When a converter is added, its
 * budget is added with it -- the lookup falls back to the strictest rate
 * rather than to an unlimited one, so forgetting this costs a contributor
 * throughput rather than costing the host a CPU.
 */
export const DEFAULT_BUDGETS: Record<JobType, Budget> = {
  'html-to-pdf': { limit: 20, windowMs: MINUTE },
}

/**
 * What a request that has not said what it wants is charged.
 *
 * The type arrives in the request body, and the whole point of limiting
 * before the body is read is that we refuse to read it. So a request that
 * does not declare its type up front pays the strictest rate we offer: we
 * cannot know what it will cost until we have read it, and reading it is
 * the expense being avoided.
 */
export const UNDECLARED: Budget = { limit: 5, windowMs: MINUTE }

/** Reads are cheap. A polling client with no backoff is not. */
export const READ_BUDGET: Budget = { limit: 240, windowMs: MINUTE }

/** The key suffix for reads, and for a create that named no type. */
const READ_KEY = 'read'
export const UNDECLARED_KEY = 'undeclared'

type Bucket = { tokens: number; updated: number }

export type RateLimiterOptions = {
  budgets?: Record<string, Budget>
  undeclared?: Budget
  read?: Budget
  clock?: () => number
  /** Buckets kept before the fully-refilled ones are dropped. */
  maxBuckets?: number
}

export type Verdict = { allowed: boolean; retryAfterSeconds: number }

/**
 * A token bucket per client, per type.
 *
 * A bucket rather than a fixed window because a fixed window lets a caller
 * spend one window's budget in its last second and the next window's in
 * its first -- twice the intended rate, at exactly the moment a flood is
 * happening.
 *
 * Per-process, which is the honest scope: with more than one API container
 * the effective limit multiplies by the container count. A shared counter
 * needs Redis, which the pre-flight found absent
 * (`docs/findings/16-phase-7-preflight.md`), and a limiter written against
 * a mock of Redis would tell us nothing. This is a real limiter with a
 * documented ceiling, not a placeholder.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly budgets: Record<string, Budget>
  private readonly undeclared: Budget
  private readonly read: Budget
  private readonly clock: () => number
  private readonly maxBuckets: number

  constructor(options: RateLimiterOptions = {}) {
    this.budgets = options.budgets ?? DEFAULT_BUDGETS
    this.undeclared = options.undeclared ?? UNDECLARED
    this.read = options.read ?? READ_BUDGET
    this.clock = options.clock ?? Date.now
    this.maxBuckets = options.maxBuckets ?? 10_000
  }

  /** `null` means a read. Anything unrecognised pays the undeclared rate. */
  budgetFor(type: string | null): Budget {
    if (type === null || type === READ_KEY) return this.read
    return this.budgets[type] ?? this.undeclared
  }

  /**
   * Spends one token.
   *
   * Each client-and-type pair gets its own bucket, which is what makes
   * exhausting one conversion type leave the other types -- and leave
   * status polling -- entirely untouched.
   */
  take(client: string, type: string | null): Verdict {
    const budget = this.budgetFor(type)
    const key = `${client} ${type ?? READ_KEY}`
    const now = this.clock()
    const bucket = this.buckets.get(key) ?? { tokens: budget.limit, updated: now }

    const refill = ((now - bucket.updated) / budget.windowMs) * budget.limit
    bucket.tokens = Math.min(budget.limit, bucket.tokens + refill)
    bucket.updated = now

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket)
      const msPerToken = budget.windowMs / budget.limit
      return {
        allowed: false,
        // Rounded up, and never zero: a client that retries at the exact
        // boundary and is refused again has learned nothing and has cost
        // us another request.
        retryAfterSeconds: Math.max(1, Math.ceil(((1 - bucket.tokens) * msPerToken) / 1000)),
      }
    }

    bucket.tokens -= 1
    this.buckets.set(key, bucket)
    this.prune(now)
    return { allowed: true, retryAfterSeconds: 0 }
  }

  /**
   * Drops buckets that have refilled completely.
   *
   * A full bucket is indistinguishable from one that never existed, so
   * forgetting it loses nothing. Without this the map grows by one entry
   * per client address forever -- both a leak and a standing record of who
   * connected and when.
   */
  private prune(now: number): void {
    if (this.buckets.size <= this.maxBuckets) return
    for (const [key, bucket] of this.buckets) {
      const type = key.slice(key.indexOf(' ') + 1)
      const budget = this.budgetFor(type)
      const refilled = bucket.tokens + ((now - bucket.updated) / budget.windowMs) * budget.limit
      if (refilled >= budget.limit) this.buckets.delete(key)
    }
  }

  /** Bucket count. Tests only -- it is the only way to watch pruning happen. */
  get size(): number {
    return this.buckets.size
  }
}

/**
 * The declared job type, from the query string.
 *
 * Not from the body: the body is exactly what this is declining to read.
 * The route compares it against the multipart field afterwards and refuses
 * a request where the two disagree, so declaring the cheap type to get its
 * budget and then uploading something else is not a way through.
 */
export function declaredType(req: FastifyRequest): JobType | null {
  const raw = (req.query as { type?: unknown } | undefined)?.type
  return typeof raw === 'string' && isJobType(raw) ? raw : null
}

export type RateLimitOptions = RateLimiterOptions & { limiter?: RateLimiter }

/**
 * Applied in `onRequest`, which is before Fastify reads the body.
 *
 * That ordering is the feature. Enforced after parsing, a flood costs a
 * 50 MB read and a disk write per request; enforced here it costs a header
 * parse and a 429.
 */
export async function rateLimit(
  app: FastifyInstance,
  options: RateLimitOptions = {},
): Promise<void> {
  const limiter = options.limiter ?? new RateLimiter(options)
  app.decorate('rateLimiter', limiter)

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // The health check is what a load balancer calls, from one address, on
    // a timer. Limiting it takes the service out of rotation.
    if (req.url === '/health') return

    const type = req.method === 'POST' ? (declaredType(req) ?? UNDECLARED_KEY) : null
    const verdict = limiter.take(req.ip, type)
    if (verdict.allowed) return

    return reply
      .code(429)
      .header('retry-after', String(verdict.retryAfterSeconds))
      .send({
        error: 'Too many requests. Try again shortly.',
        retryAfter: verdict.retryAfterSeconds,
      })
  })
}

declare module 'fastify' {
  interface FastifyInstance {
    rateLimiter: RateLimiter
  }
}
