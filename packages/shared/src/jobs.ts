import { z } from 'zod'

/**
 * The conversions the backend offers.
 *
 * ONE entry, and that is deliberate. `PLAN.md` §3 lists six job types;
 * five of them need LibreOffice, Tesseract, or Ghostscript, none of which
 * could be run when this was written (docs/findings/16-phase-7-preflight.md).
 *
 * A type with no converter is ABSENT rather than stubbed. A stub that
 * throws at runtime is a feature that appears in the UI, gets chosen, and
 * fails after the upload -- which is worse than a feature that is not
 * offered. Adding one here is what makes it reachable, so the list and the
 * capability cannot drift apart.
 */
export const JOB_TYPES = ['html-to-pdf'] as const
export const jobType = z.enum(JOB_TYPES)
export type JobType = z.infer<typeof jobType>

export function isJobType(value: unknown): value is JobType {
  return jobType.safeParse(value).success
}

/**
 * Where a job is.
 *
 * `expired` is distinct from `failed` on purpose. A user who comes back an
 * hour later should be told their file was deleted on schedule -- which is
 * the product working as promised -- rather than that something went
 * wrong. Collapsing the two would make the privacy guarantee look like a
 * bug.
 */
export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'expired'] as const
export const jobStatus = z.enum(JOB_STATUSES)
export type JobStatus = z.infer<typeof jobStatus>

/** Terminal states: nothing further will happen, so polling can stop. */
export const TERMINAL_STATUSES: readonly JobStatus[] = ['done', 'failed', 'expired']
export const isTerminal = (status: JobStatus): boolean => TERMINAL_STATUSES.includes(status)

/**
 * A job id is 32 random bytes, base64url.
 *
 * It is the ONLY credential for reading a result, so it has to be
 * unguessable -- and it doubles as the storage directory name, so a
 * listing of the storage root reveals nothing about who uploaded what or
 * how many.
 */
export const JOB_ID_LENGTH = 43
export const jobId = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'not a job id')
export type JobId = z.infer<typeof jobId>

export const createJobResponse = z.object({
  jobId,
  statusUrl: z.string(),
})
export type CreateJobResponse = z.infer<typeof createJobResponse>

export const jobStatusResponse = z.object({
  jobId,
  type: jobType,
  status: jobStatus,
  /** 0..1, or absent when the converter cannot report it. */
  progress: z.number().min(0).max(1).optional(),
  /**
   * Why it failed, in language a user can act on. Never contains the
   * filename or any part of the file -- see the API's logging rules.
   */
  error: z.string().optional(),
  /** Whether a result exists to download RIGHT NOW. */
  resultReady: z.boolean(),
})
export type JobStatusResponse = z.infer<typeof jobStatusResponse>

export const errorResponse = z.object({
  error: z.string(),
  /** Seconds to wait, when the refusal is a rate limit. */
  retryAfter: z.number().optional(),
})
export type ErrorResponse = z.infer<typeof errorResponse>

/** How long a job's files live, whatever happens to the job itself. */
export const JOB_TTL_MS = 60 * 60 * 1000

/** The largest upload the API accepts, before anything is written to disk. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
