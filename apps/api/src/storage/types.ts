import { randomBytes } from 'node:crypto'
import { JOB_ID_LENGTH, jobId, type JobId } from '@margin/shared'

/**
 * The two things a job owns on disk. Both are user data; neither outlives
 * the job.
 *
 * `input` is what was uploaded. `result` is what the converter produced.
 * They are separate entries under one directory so a failed job's input
 * can be deleted by the same code path that deletes a succeeded job's
 * result -- deletion never has to know how the job went.
 */
export type Slot = 'input' | 'result'

/**
 * 32 random bytes, base64url.
 *
 * The id is the ONLY credential for reading a result. There are no
 * accounts, so anyone holding the id is the owner; anyone who can guess an
 * id is also the owner. 32 bytes from the CSPRNG makes guessing
 * uninteresting.
 *
 * It doubles as the directory name, so listing the storage root reveals
 * nothing about who uploaded what -- no filename, no timestamp in the
 * name, no sequence to count.
 */
export function newJobId(): JobId {
  // base64url of 32 bytes is 43 chars with no padding -- JOB_ID_LENGTH.
  const id = randomBytes(32).toString('base64url')
  // Cheap assertion rather than a comment claiming the arithmetic: if the
  // encoding ever changes shape, this fails here rather than at the router.
  return jobId.parse(id)
}

export { JOB_ID_LENGTH }

/**
 * Where job files live.
 *
 * Local disk today, S3 later. The interface is deliberately small and
 * says nothing about paths, so an S3 adapter is an addition rather than a
 * rewrite of every call site.
 *
 * Every method takes a job id rather than a path: the caller never
 * constructs a location, so a caller cannot construct one that escapes the
 * root.
 */
export interface StorageAdapter {
  /** Writes (or overwrites) a slot. Creates the job directory if needed. */
  put(id: JobId, slot: Slot, bytes: Uint8Array): Promise<void>
  /** The bytes, or `null` when the job or slot does not exist. */
  get(id: JobId, slot: Slot): Promise<Uint8Array | null>
  /**
   * Removes the WHOLE job, both slots, and the directory.
   *
   * Idempotent: deleting what is not there is a success, because every
   * deletion path races every other one and none of them may throw.
   */
  delete(id: JobId): Promise<void>
  /** Byte length of a slot, or `null` when absent. */
  size(id: JobId, slot: Slot): Promise<number | null>
  /** Milliseconds since the job directory was created, or `null` when absent. */
  age(id: JobId, now: number): Promise<number | null>
  /**
   * Every job id currently stored.
   *
   * Only the sweeper needs this, and it needs it because the sweeper's
   * whole purpose is finding jobs nothing else remembers -- orphans left
   * by a crash between "wrote the file" and "recorded the job".
   */
  list(): Promise<JobId[]>
}
