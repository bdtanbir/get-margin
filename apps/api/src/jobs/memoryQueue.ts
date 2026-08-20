import type { JobId, JobType } from '@margin/shared'
import type { JobHandler, JobQueue, JobRecord, JobRun } from './types.js'

export type MemoryQueueOptions = {
  /** Called when a job reaches a terminal state. Bytes are handed over, not stored. */
  onComplete?: (id: JobId, result: Uint8Array | null) => void | Promise<void>
}

/**
 * The queue that actually runs here.
 *
 * Handlers start on the microtask queue rather than on a timer, so a test
 * can `await queue.drain()` and know the work is finished -- no sleeping,
 * no polling, no flake. That is the whole reason this exists in-process
 * rather than being deferred until Redis is available.
 *
 * It holds job RECORDS in memory, never job bytes: the input goes to the
 * handler and the result goes to `onComplete`, which writes it to storage.
 * A queue that kept the file would be a second copy nothing deletes.
 */
export class MemoryQueue implements JobQueue {
  private readonly handlers = new Map<JobType, JobHandler>()
  private readonly records = new Map<JobId, JobRecord>()
  private readonly aborts = new Map<JobId, AbortController>()
  private readonly listeners = new Set<(id: JobId, progress: number) => void>()
  private readonly inFlight = new Set<Promise<void>>()
  private readonly pending: Array<() => void> = []
  private pump: NodeJS.Timeout | null = null

  constructor(private readonly options: MemoryQueueOptions = {}) {}

  register(type: JobType, handler: JobHandler): void {
    this.handlers.set(type, handler)
  }

  async enqueue(id: JobId, type: JobType, input: Uint8Array): Promise<void> {
    const record: JobRecord = { id, type, status: 'queued' }
    this.records.set(id, record)
    const controller = new AbortController()
    this.aborts.set(id, controller)

    // Deferred to a TASK, not a microtask. A microtask would be drained by
    // the caller's own `await enqueue(...)`, so the job would already be
    // running by the time `enqueue` returned and `queued` would be a state
    // nothing could ever observe -- including a cancel arriving right
    // after submission, which is exactly the case that must work.
    this.pending.push(() => {
      const running = this.run(record, input, controller)
      this.inFlight.add(running)
      void running.finally(() => this.inFlight.delete(running))
    })
    this.schedule()
  }

  private schedule(): void {
    if (this.pump) return
    this.pump = setTimeout(() => {
      this.pump = null
      const batch = this.pending.splice(0)
      for (const start of batch) start()
    }, 0)
    this.pump.unref?.()
  }

  private async run(record: JobRecord, input: Uint8Array, controller: AbortController): Promise<void> {
    // Cancelled before it started: it never runs, and there is nothing to
    // discard. `cancel` has already set the status.
    if (controller.signal.aborted) return

    const handler = this.handlers.get(record.type)
    if (!handler) {
      // Unreachable through the API -- the router rejects a type the
      // shared schema does not contain, and the schema only contains types
      // with converters. Belt and braces for a wiring mistake.
      record.status = 'failed'
      record.error = 'No converter is registered for this job type.'
      await this.options.onComplete?.(record.id, null)
      return
    }

    record.status = 'running'
    const run: JobRun = {
      id: record.id,
      type: record.type,
      input,
      signal: controller.signal,
      report: (progress) => {
        if (record.status !== 'running') return
        const clamped = Math.min(1, Math.max(0, progress))
        record.progress = clamped
        for (const listener of this.listeners) listener(record.id, clamped)
      },
    }

    try {
      const result = await handler(run)
      // A job cancelled while running produces bytes nobody asked for.
      // Dropping them here is what makes cancel mean something.
      if (controller.signal.aborted) {
        await this.options.onComplete?.(record.id, null)
        return
      }
      record.status = 'done'
      record.progress = 1
      await this.options.onComplete?.(record.id, result)
    } catch (err) {
      if (controller.signal.aborted) {
        await this.options.onComplete?.(record.id, null)
        return
      }
      record.status = 'failed'
      record.error = message(err)
      // Deletion is NOT contingent on success. A failed job still had a
      // file uploaded, and that file is the thing that matters.
      await this.options.onComplete?.(record.id, null)
    } finally {
      this.aborts.delete(record.id)
    }
  }

  status(id: JobId): JobRecord | null {
    return this.records.get(id) ?? null
  }

  onProgress(listener: (id: JobId, progress: number) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  cancel(id: JobId): boolean {
    const record = this.records.get(id)
    if (!record || record.status !== 'queued' && record.status !== 'running') return false
    this.aborts.get(id)?.abort()
    this.aborts.delete(id)
    record.status = 'failed'
    record.error = 'Cancelled.'
    return true
  }

  /** Forgets a job entirely -- used by purge, so a purged id is indistinguishable from one that never existed. */
  forget(id: JobId): void {
    this.records.delete(id)
    this.aborts.delete(id)
  }

  async drain(): Promise<void> {
    // Two things to wait for: jobs not yet started (the pump has not fired)
    // and jobs running. `onComplete` can produce more of either, so this
    // loops until both are genuinely empty rather than awaiting one snapshot.
    while (this.pending.length > 0 || this.inFlight.size > 0) {
      if (this.inFlight.size > 0) await Promise.all([...this.inFlight])
      else await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
}

/**
 * An error message safe to show a user.
 *
 * Only `Error.message` is taken, never a stack and never the object --
 * converters are handed attacker-controlled bytes and a thrown value can
 * be anything, including a string built from the input.
 */
function message(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return 'Conversion failed.'
}
