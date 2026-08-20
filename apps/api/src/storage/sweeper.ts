import { JOB_TTL_MS } from '@margin/shared'
import type { StorageAdapter } from './types.js'

/** Injected so tests can move time without sleeping. */
export type Clock = () => number

export type SweeperOptions = {
  ttlMs?: number
  intervalMs?: number
  clock?: Clock
  /** Called after each pass. Reports a count only -- never an id, never a name. */
  onSwept?: (removed: number) => void
}

/**
 * Deletes anything past the TTL.
 *
 * This is the fourth and last deletion path, and the only one that does
 * not depend on anything else working. Download-deletion needs a
 * download; purge needs a client; TTL-on-read needs a read. The sweeper
 * needs nothing, which is why it is the one that actually backs the
 * privacy claim: a file uploaded to a job that then crashed still leaves
 * within the hour.
 *
 * It is an in-process interval rather than a cron container because a cron
 * that has to be deployed separately is a cron that eventually is not.
 */
export class Sweeper {
  private readonly ttlMs: number
  private readonly intervalMs: number
  private readonly clock: Clock
  private readonly onSwept: ((removed: number) => void) | undefined
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly storage: StorageAdapter,
    options: SweeperOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? JOB_TTL_MS
    this.intervalMs = options.intervalMs ?? 60_000
    this.clock = options.clock ?? Date.now
    this.onSwept = options.onSwept
  }

  /** One pass. Returns how many jobs it removed. */
  async sweep(): Promise<number> {
    const now = this.clock()
    const ids = await this.storage.list()
    let removed = 0
    for (const id of ids) {
      // Between list() and here, a download or a purge may have removed
      // this job. `age` returning null and `delete` being idempotent are
      // what make that a non-event rather than a crash -- a sweeper that
      // throws on a race stops sweeping everything after it.
      const age = await this.storage.age(id, now)
      if (age === null || age < this.ttlMs) continue
      await this.storage.delete(id)
      removed++
    }
    this.onSwept?.(removed)
    return removed
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      // A rejected sweep must not take the process down. The next pass
      // will find the same files and try again.
      void this.sweep().catch(() => {})
    }, this.intervalMs)
    // Do not hold the event loop open: the API's lifetime decides when the
    // process exits, not the sweeper's.
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }
}
