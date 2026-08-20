import type { JobId, JobStatus, JobType } from '@margin/shared'

/**
 * What a handler is given and what it returns.
 *
 * `input` is bytes, not a path and not a filename. The queue never learns
 * where the file came from or what it was called -- there is nothing for
 * a log line or an error message to leak.
 */
export type JobRun = {
  readonly id: JobId
  readonly type: JobType
  readonly input: Uint8Array
  /** 0..1. Converters that cannot measure themselves simply never call it. */
  report(progress: number): void
  /** Resolves once the job has been cancelled; a long handler can race it. */
  readonly signal: AbortSignal
}

export type JobHandler = (run: JobRun) => Promise<Uint8Array>

/** What the API can see about a job without touching storage. */
export type JobRecord = {
  readonly id: JobId
  readonly type: JobType
  status: JobStatus
  progress?: number
  /**
   * Why it failed, in words a user can act on. Handlers are responsible
   * for not putting the input in here; the API refuses to forward
   * anything else.
   */
  error?: string
}

/**
 * The queue, behind an interface.
 *
 * The in-process implementation is what runs here -- the pre-flight found
 * no Redis, and a BullMQ adapter tested against a mock of itself proves
 * nothing. BullMQ becomes one more class implementing this, and no call
 * site changes.
 */
export interface JobQueue {
  /** Registers the handler for a type. Enqueueing a type with no handler fails the job. */
  register(type: JobType, handler: JobHandler): void
  /** Accepts work. Resolves once the job is recorded, NOT once it is done. */
  enqueue(id: JobId, type: JobType, input: Uint8Array): Promise<void>
  /** The record, or `null` for an id the queue has never seen. */
  status(id: JobId): JobRecord | null
  /** Fires on every progress report. Used for logging and for the status route. */
  onProgress(listener: (id: JobId, progress: number) => void): () => void
  /**
   * Stops a job. Returns whether there was anything to stop.
   *
   * A queued job never starts. A running job is signalled and its result
   * discarded -- a converter in a C++ parser cannot be interrupted, so
   * "cancel" means "the answer is thrown away", not "the CPU is freed".
   */
  cancel(id: JobId): boolean
  /**
   * Drops the record entirely, so the id reads as one that never existed.
   *
   * Purge uses it. A purged job that still answered `expired` would be
   * telling the caller that an id they asked us to forget was once real --
   * which is exactly the thing they asked us to forget.
   */
  forget(id: JobId): void
  /** Resolves when nothing is queued or running. Tests only. */
  drain(): Promise<void>
}
