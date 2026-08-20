import { pino, type Logger } from 'pino'
import type { JobId, JobStatus, JobType } from '@margin/shared'

/**
 * Everything the API is allowed to log about a job.
 *
 * This type IS the policy. `PLAN.md` §4 forbids logging filenames, file
 * contents, and job payloads, and the failure mode is silent -- a leaked
 * filename looks exactly like a working log line. So the defence is not a
 * redaction list bolted on afterwards: nothing outside this shape is
 * passed to the logger in the first place.
 *
 * A filename is user data, and it is frequently the sensitive thing on its
 * own: `2024-tax-return-jane-doe.pdf` discloses the contents without the
 * file. That is the same argument the privacy page already makes about
 * IndexedDB.
 */
export type JobLogFields = {
  jobId: JobId
  type: JobType
  /** Byte size. A number cannot carry a name or a payload. */
  bytes?: number
  durationMs?: number
  outcome?: JobStatus
  /** HTTP status, for request lines. */
  status?: number
}

/**
 * Keys that must never appear, whatever route or dependency produced them.
 *
 * The allowlist above is the real control; this is the second one, for the
 * lines this code does not write -- Fastify's own request logging, a
 * plugin's error serialiser, a future contributor's `log.info({ file })`.
 */
export const REDACTED_PATHS = [
  'filename',
  'fileName',
  'file',
  'files',
  'originalname',
  'originalName',
  'name',
  'path',
  'body',
  'payload',
  'content',
  'contents',
  'data',
  'input',
  'result',
  'buffer',
  'bytes.*',
  'headers',
  'cookie',
  'authorization',
  'url',
  'req.body',
  'req.headers',
  'req.query',
  'req.url',
  'res.headers',
  'err.stack',
  '*.headers',
  '*.cookie',
  '*.authorization',
  '*.url',
  '*.filename',
  '*.fileName',
  '*.originalname',
  '*.path',
  '*.body',
  '*.payload',
  '*.content',
  '*.data',
]

export type LoggerOptions = {
  level?: string
  /** Where lines go. Tests pass a stream they can read back. */
  destination?: NodeJS.WritableStream
}

/**
 * A logger that cannot be talked into printing user data.
 *
 * `redact` replaces matching keys with `[redacted]` rather than removing
 * them, so a leak that would have happened is visible in the output as a
 * marker -- silence would hide the mistake as well as the value.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const config = {
    level: options.level ?? 'info',
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    /**
     * Fastify logs the request line by default, and a URL can carry user
     * data in a query string. Only the fields below are serialised; the
     * raw request never reaches the output.
     */
    serializers: {
      req: (req: { method?: string; routeOptions?: { url?: string } }) => ({
        method: req.method,
        // The ROUTE, e.g. `/v1/jobs/:id`, not the URL -- the concrete URL
        // contains a job id, which is a credential.
        route: req.routeOptions?.url,
      }),
      res: (res: { statusCode?: number }) => ({ status: res.statusCode }),
      err: (err: Error) => ({ type: err.name, message: err.message }),
    },
  }
  return options.destination ? pino(config, options.destination) : pino(config)
}

/** Narrows an arbitrary object to the allowlist. Anything else is dropped, not redacted. */
export function jobFields(fields: JobLogFields): JobLogFields {
  const { jobId, type, bytes, durationMs, outcome, status } = fields
  const out: JobLogFields = { jobId, type }
  if (bytes !== undefined) out.bytes = bytes
  if (durationMs !== undefined) out.durationMs = durationMs
  if (outcome !== undefined) out.outcome = outcome
  if (status !== undefined) out.status = status
  return out
}
