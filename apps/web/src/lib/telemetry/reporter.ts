import { TELEMETRY_SCHEMA, type ErrorEvent, type TelemetryEvent, type Transport } from './types'
import { errorMessage, errorType, safeComponent, safeName } from './scrub'

/**
 * Where reports would go, if anywhere.
 *
 * EMPTY BY DEFAULT, exactly like `CONVERT_API_BASE`. With nothing
 * configured there is no endpoint, no transport is constructed, and
 * `enabled` is false no matter what anyone consents to -- so the shipped
 * build sends nothing and the privacy page's claim stays literally true.
 */
export const TELEMETRY_ENDPOINT: string =
  (import.meta.env?.VITE_TELEMETRY_ENDPOINT as string | undefined)?.replace(/\/$/, '') ?? ''

export function telemetryConfigured(endpoint: string = TELEMETRY_ENDPOINT): boolean {
  return endpoint.length > 0
}

export type ReporterOptions = {
  endpoint?: string
  /** Read on every send, not captured once: consent can be withdrawn. */
  consent?: () => boolean
  transport?: Transport
  /** Events held before a send is forced. Small: this is not a data pipeline. */
  maxQueue?: number
}

/**
 * Collects events and sends them only when it is allowed to.
 *
 * Two independent conditions, both required: an endpoint has to be
 * configured by whoever deployed the app, and the person using it has to
 * have said yes. Neither implies the other, and the tests assert each one
 * alone is not enough.
 */
export class Reporter {
  private readonly endpoint: string
  private readonly consent: () => boolean
  private readonly transport: Transport | undefined
  private readonly maxQueue: number
  private queue: TelemetryEvent[] = []
  private readonly counts = new Map<string, number>()

  constructor(options: ReporterOptions = {}) {
    this.endpoint = options.endpoint ?? TELEMETRY_ENDPOINT
    this.consent = options.consent ?? (() => false)
    this.transport = options.transport
    this.maxQueue = options.maxQueue ?? 32
  }

  /** Both conditions, evaluated fresh every time. */
  get enabled(): boolean {
    return telemetryConfigured(this.endpoint) && this.consent()
  }

  /**
   * Record a failure.
   *
   * Takes the error itself rather than a message so the caller cannot pass
   * a string it built out of the document. What survives is the type and a
   * scrubbed message; the stack is never read.
   */
  reportError(input: { name: string; component: string; error: unknown }): void {
    if (!this.enabled) return
    const event: ErrorEvent = {
      schema: TELEMETRY_SCHEMA,
      kind: 'error',
      // Validated, not scrubbed. These are supposed to be constants chosen
      // by the code, and "supposed to" is not a control -- but a scrubber
      // cannot tell `export:pdf` from a filename, so the check is a shape
      // a filename cannot have. See `safeName`.
      name: safeName(input.name),
      component: safeComponent(input.component),
      errorType: errorType(input.error),
      message: errorMessage(input.error),
    }
    this.push(event)
  }

  /**
   * Record that a feature was used. Never what it was used on.
   *
   * Counted rather than sent one-per-use, so what leaves is "export:pdf: 4"
   * -- a number that cannot describe a document.
   */
  countUsage(name: string): void {
    if (!this.enabled) return
    const key = safeName(name)
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1)
  }

  private push(event: TelemetryEvent): void {
    this.queue.push(event)
    if (this.queue.length >= this.maxQueue) void this.flush()
  }

  /** Everything waiting, as it would be transmitted. Tests read this. */
  pending(): TelemetryEvent[] {
    const usage: TelemetryEvent[] = [...this.counts].map(([name, count]) => ({
      schema: TELEMETRY_SCHEMA,
      kind: 'usage',
      name,
      count,
    }))
    return [...this.queue, ...usage]
  }

  async flush(): Promise<void> {
    const events = this.pending()
    this.queue = []
    this.counts.clear()
    // Re-checked here as well as at record time: consent can be withdrawn
    // between an event being queued and the queue being sent, and the
    // later answer is the one that counts.
    if (events.length === 0 || !this.enabled || !this.transport) return
    try {
      await this.transport(events)
    } catch {
      // A failed send is dropped, not retried and not logged. Retrying
      // would build a store of user-adjacent data waiting for a network,
      // which is the thing this module exists to avoid holding.
    }
  }
}

/**
 * A transport that posts JSON.
 *
 * Constructed only when an endpoint exists, so the default build has no
 * code path that can reach the network.
 */
export function httpTransport(endpoint: string, fetchFn: typeof fetch = fetch): Transport {
  return async (events) => {
    await fetchFn(`${endpoint}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
      // No cookies and no credentials: there is no session here, and
      // sending one would make these reports linkable to a person.
      credentials: 'omit',
      keepalive: true,
    })
  }
}

/** The app's single reporter. Replaced wholesale by tests rather than mutated. */
let current = new Reporter()

export function reporter(): Reporter {
  return current
}

export function configureReporter(options: ReporterOptions): Reporter {
  current = new Reporter(options)
  return current
}
