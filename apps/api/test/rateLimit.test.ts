import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { createLogger } from '../src/plugins/logging.js'
import { RateLimiter, UNDECLARED_KEY } from '../src/plugins/rateLimit.js'
import { createApi } from '../src/server.js'

const MINUTE = 60_000

describe('RateLimiter', () => {
  const budgets = {
    cheap: { limit: 3, windowMs: MINUTE },
    expensive: { limit: 1, windowMs: MINUTE },
  }
  const at = (t: { now: number }) => () => t.now

  it('allows exactly the configured number, then refuses', () => {
    const limiter = new RateLimiter({ budgets, clock: () => 0 })
    for (let i = 0; i < 3; i++) expect(limiter.take('a', 'cheap').allowed).toBe(true)
    expect(limiter.take('a', 'cheap').allowed).toBe(false)
  })

  it('leaves a different client alone', () => {
    const limiter = new RateLimiter({ budgets, clock: () => 0 })
    for (let i = 0; i < 3; i++) limiter.take('a', 'cheap')
    expect(limiter.take('a', 'cheap').allowed).toBe(false)
    expect(limiter.take('b', 'cheap').allowed).toBe(true)
  })

  /**
   * The one that matters. The budgets differ because the costs differ by
   * an order of magnitude, and that is worth nothing if spending the cheap
   * budget also closes the expensive one -- a user who rendered twenty
   * HTML files would find OCR unavailable for a minute.
   */
  it('does not let one job type exhaust another', () => {
    const limiter = new RateLimiter({ budgets, clock: () => 0 })
    for (let i = 0; i < 3; i++) limiter.take('a', 'cheap')
    expect(limiter.take('a', 'cheap').allowed).toBe(false)
    expect(limiter.take('a', 'expensive').allowed).toBe(true)
  })

  it('does not let conversions exhaust status polling, or the reverse', () => {
    const limiter = new RateLimiter({ budgets, read: { limit: 2, windowMs: MINUTE }, clock: () => 0 })
    for (let i = 0; i < 3; i++) limiter.take('a', 'cheap')
    expect(limiter.take('a', 'cheap').allowed).toBe(false)
    expect(limiter.take('a', null).allowed).toBe(true)
    limiter.take('a', null)
    expect(limiter.take('a', null).allowed).toBe(false)
  })

  it('charges an unrecognised type the strictest rate', () => {
    const limiter = new RateLimiter({
      budgets,
      undeclared: { limit: 1, windowMs: MINUTE },
      clock: () => 0,
    })
    expect(limiter.take('a', UNDECLARED_KEY).allowed).toBe(true)
    expect(limiter.take('a', UNDECLARED_KEY).allowed).toBe(false)
  })

  it('says when to try again, in whole seconds and never zero', () => {
    const limiter = new RateLimiter({ budgets, clock: () => 0 })
    limiter.take('a', 'expensive')
    const verdict = limiter.take('a', 'expensive')
    expect(verdict.allowed).toBe(false)
    // One token per minute for this budget, so a full window.
    expect(verdict.retryAfterSeconds).toBe(60)
    expect(Number.isInteger(verdict.retryAfterSeconds)).toBe(true)
  })

  it('refills over time rather than resetting on a boundary', () => {
    const t = { now: 0 }
    const limiter = new RateLimiter({ budgets, clock: at(t) })
    for (let i = 0; i < 3; i++) limiter.take('a', 'cheap')
    expect(limiter.take('a', 'cheap').allowed).toBe(false)

    // A third of the window buys back exactly one of three tokens.
    t.now += MINUTE / 3
    expect(limiter.take('a', 'cheap').allowed).toBe(true)
    expect(limiter.take('a', 'cheap').allowed).toBe(false)
  })

  /**
   * The bucket map is keyed by client address. Left to grow it is both a
   * leak and a standing record of who connected, which is not something
   * this service should be keeping.
   */
  it('forgets clients whose buckets have refilled', () => {
    const t = { now: 0 }
    const limiter = new RateLimiter({ budgets, clock: at(t), maxBuckets: 5 })
    for (let i = 0; i < 20; i++) limiter.take(`client-${i}`, 'cheap')
    expect(limiter.size).toBeGreaterThan(5)

    t.now += MINUTE * 2
    limiter.take('someone-new', 'cheap')
    // Everything drawn before the wait has refilled and is now indistinguishable
    // from a client that never called, so only the fresh one is retained.
    expect(limiter.size).toBe(1)
  })
})

describe('the limit, through the API', () => {
  const BOUNDARY = '----marginRateLimit'
  const HTML = '<!DOCTYPE html><html><body>hi</body></html>'

  function body(html: string = HTML) {
    return {
      payload: Buffer.concat([
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="type"\r\n\r\nhtml-to-pdf\r\n`,
        ),
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.html"\r\n` +
            `Content-Type: text/html\r\n\r\n`,
        ),
        Buffer.from(html),
        Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
      ]),
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    }
  }

  let root: string
  let app: FastifyInstance
  let queue: { drain(): Promise<void> }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'margin-ratelimit-'))
    const api = await createApi({
      storageRoot: root,
      sweep: false,
      maxUploadBytes: 2048,
      logger: createLogger({ destination: new Writable({ write: (_c, _e, cb) => cb() }) }),
      rateLimit: {
        budgets: { 'html-to-pdf': { limit: 2, windowMs: MINUTE } },
        undeclared: { limit: 1, windowMs: MINUTE },
        read: { limit: 3, windowMs: MINUTE },
        clock: () => 0,
      },
      handlers: { 'html-to-pdf': async () => new TextEncoder().encode('%PDF-1.7\n') },
    })
    app = api.app
    queue = api.queue
  })

  afterEach(async () => {
    // These tests post jobs and then assert on status codes, so unlike the
    // route suite they never wait for the conversions. Removing the
    // storage root while a handler is still writing its result is a race
    // the test would lose, and it would look like a product bug.
    await queue.drain()
    await app.close()
    await rm(root, { recursive: true, force: true })
  })

  const post = (url: string, ip = '203.0.113.1', payload = body()) =>
    app.inject({
      method: 'POST',
      url,
      ...payload,
      headers: { ...payload.headers, 'x-forwarded-for': ip },
    })

  it('trips at the configured count and says when to retry', async () => {
    const url = '/v1/jobs?type=html-to-pdf'
    expect((await post(url)).statusCode).toBe(202)
    expect((await post(url)).statusCode).toBe(202)

    const refused = await post(url)
    expect(refused.statusCode).toBe(429)
    expect(refused.json().retryAfter).toBeGreaterThan(0)
    expect(refused.headers['retry-after']).toBe(String(refused.json().retryAfter))
  })

  it('leaves a different address alone', async () => {
    const url = '/v1/jobs?type=html-to-pdf'
    await post(url)
    await post(url)
    expect((await post(url)).statusCode).toBe(429)
    expect((await post(url, '198.51.100.7')).statusCode).toBe(202)
  })

  /**
   * Refusing before the body is read is the whole point: otherwise a flood
   * costs a full upload and a disk write per request.
   *
   * The proof is the status code. This payload is over the size cap, so a
   * server that had read it would answer 413. Answering 429 means the
   * refusal happened while the body was still on the wire.
   */
  it('refuses before it reads the body', async () => {
    const url = '/v1/jobs?type=html-to-pdf'
    await post(url)
    await post(url)
    // The two accepted jobs above have results waiting to be downloaded,
    // so the root is not empty. What matters is that the refused request
    // added nothing to it.
    const before = (await readdir(root)).sort()

    const oversized = body('<html>' + 'a'.repeat(8192) + '</html>')
    const refused = await post(url, '203.0.113.1', oversized)
    expect(refused.statusCode).toBe(429)
    expect((await readdir(root)).sort()).toEqual(before)
  })

  it('charges a request that declared no type the stricter budget', async () => {
    // One, not two: an undeclared request cannot be priced, so it pays the
    // strictest rate rather than the one it hopes for.
    expect((await post('/v1/jobs')).statusCode).toBe(202)
    expect((await post('/v1/jobs')).statusCode).toBe(429)
    // And the declared budget is untouched by that exhaustion.
    expect((await post('/v1/jobs?type=html-to-pdf')).statusCode).toBe(202)
  })

  it('refuses a request whose declared type disagrees with the file it sent', async () => {
    const res = await post('/v1/jobs?type=html-to-pdf', '203.0.113.9', {
      payload: Buffer.concat([
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="type"\r\n\r\noffice-to-pdf\r\n`,
        ),
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.html"\r\n\r\n`,
        ),
        Buffer.from(HTML),
        Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
      ]),
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('disagree')
  })

  it('keeps conversions and status polling on separate budgets', async () => {
    const url = '/v1/jobs?type=html-to-pdf'
    const { jobId } = (await post(url)).json()
    await post(url)
    expect((await post(url)).statusCode).toBe(429)

    const status = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobId}`,
      headers: { 'x-forwarded-for': '203.0.113.1' },
    })
    expect(status.statusCode).toBe(200)
  })

  /** A load balancer calls this on a timer from one address. Limiting it takes the service out of rotation. */
  it('never limits the health check', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-forwarded-for': '203.0.113.1' },
      })
      expect(res.statusCode).toBe(200)
    }
  })
})
