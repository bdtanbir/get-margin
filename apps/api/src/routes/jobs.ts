import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  isJobType,
  jobId as jobIdSchema,
  type CreateJobResponse,
  type JobId,
  type JobStatusResponse,
  type JobType,
} from '@margin/shared'
import { newJobId } from '../storage/types.js'
import type { StorageAdapter } from '../storage/types.js'
import type { JobQueue } from '../jobs/types.js'
import { sniff } from '../upload/sniff.js'
import { jobFields } from '../plugins/logging.js'
import { declaredType } from '../plugins/rateLimit.js'

export type JobRoutesOptions = {
  storage: StorageAdapter
  queue: JobQueue
  maxUploadBytes: number
}

/**
 * What comes back out, per job type.
 *
 * The filename is a CONSTANT. We never learned what the user called their
 * file -- it is not read from the upload, not stored, and not echoed -- so
 * there is no untrusted string to sanitise into a `Content-Disposition`
 * header in the first place. That is the sanitisation: not escaping a
 * dangerous value, but never holding one.
 */
const RESULT: Record<JobType, { contentType: string; filename: string }> = {
  'html-to-pdf': { contentType: 'application/pdf', filename: 'converted.pdf' },
}

/** 404 for everything unknown, in identical words. */
const NOT_FOUND = { error: 'No such job. It may have been deleted or it may never have existed.' }

/**
 * Parses `:id` as a job id.
 *
 * A malformed id gets the same 404 as a well-formed unknown one. Telling a
 * caller "that is not a valid id" versus "that id is not here" is a
 * distinction only somebody enumerating ids has any use for.
 */
function paramId(req: FastifyRequest): JobId | null {
  const raw = (req.params as { id?: unknown }).id
  const parsed = jobIdSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export async function jobRoutes(app: FastifyInstance, options: JobRoutesOptions): Promise<void> {
  const { storage, queue, maxUploadBytes } = options

  /**
   * Create a job.
   *
   * The whole upload is buffered in memory and validated before anything
   * touches disk, so a rejected file never existed on our filesystem.
   * Memory is bounded by the multipart `fileSize` limit, which busboy
   * enforces on the stream -- the cap is applied while reading, not after.
   */
  app.post('/v1/jobs', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.isMultipart()) {
      return reply.code(415).send({ error: 'Send the file as multipart/form-data.' })
    }

    let bytes: Uint8Array | null = null
    let rawType: string | null = null

    try {
      // Iterating parts rather than calling `req.file()` makes the request
      // order-independent: the `type` field may arrive before or after the
      // file. `req.file()` only exposes fields seen before it.
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          // One file. A second is not merged, not ignored silently, and
          // not stored -- it is a malformed request.
          if (bytes) return reply.code(400).send({ error: 'Send exactly one file.' })
          const buf = await part.toBuffer()
          if (part.file.truncated) {
            return reply.code(413).send({ error: tooLarge(maxUploadBytes) })
          }
          bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
          // part.filename is deliberately not read. See RESULT above.
        } else if (part.fieldname === 'type' && typeof part.value === 'string') {
          rawType = part.value
        }
      }
    } catch (err) {
      if (isTooLarge(err)) return reply.code(413).send({ error: tooLarge(maxUploadBytes) })
      throw err
    }

    /**
     * Two places can name the type: `?type=` and the multipart field.
     *
     * The query string is what the rate limiter saw, before the body was
     * read. If the body then names a different type, the request has been
     * charged the wrong budget -- declaring the cheap conversion to buy a
     * generous limit and then uploading the expensive one. So a
     * disagreement is refused rather than resolved in either direction.
     */
    const declared = declaredType(req)
    if (declared && rawType && declared !== rawType) {
      return reply.code(400).send({ error: 'The declared and submitted conversion types disagree.' })
    }
    const type = rawType ?? declared
    if (!type || !isJobType(type)) {
      // Refusing without naming the alternatives is safe -- the capability
      // list is ours, not the caller's data -- but it is the only way a
      // client can tell "unsupported" from "misspelled".
      return reply.code(400).send({ error: 'Unsupported conversion type.' })
    }
    if (!bytes || bytes.length === 0) {
      return reply.code(400).send({ error: 'No file was sent.' })
    }

    const verdict = sniff(type, bytes)
    if (!verdict.ok) return reply.code(415).send({ error: verdict.reason })

    // Only now does anything get written.
    const id = await createJob(type, bytes)
    const body: CreateJobResponse = { jobId: id, statusUrl: `/v1/jobs/${id}` }
    req.log.info(jobFields({ jobId: id, type, bytes: bytes.length }), 'job accepted')
    return reply.code(202).send(body)
  })

  async function createJob(type: JobType, bytes: Uint8Array): Promise<JobId> {
    const id = newJobId()
    // Input first, then enqueue. The other order can leave a handler
    // running against a file that is not there yet.
    await storage.put(id, 'input', bytes)
    await queue.enqueue(id, type, bytes)
    return id
  }

  /**
   * Where the job is.
   *
   * `expired` is derived, not stored: the queue says `done`, storage says
   * the result is gone. That happens after a download and after a sweep,
   * and in both cases the truthful answer is "your file was deleted", not
   * "something failed".
   */
  app.get('/v1/jobs/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const id = paramId(req)
    if (!id) return reply.code(404).send(NOT_FOUND)
    const record = queue.status(id)
    if (!record) return reply.code(404).send(NOT_FOUND)

    let status = record.status
    let resultReady = false
    if (status === 'done') {
      const size = await storage.size(id, 'result')
      if (size === null) status = 'expired'
      else resultReady = true
    }

    const body: JobStatusResponse = { jobId: id, type: record.type, status, resultReady }
    if (record.progress !== undefined) body.progress = record.progress
    if (record.error !== undefined) body.error = record.error
    return reply.send(body)
  })

  /**
   * The result, once. Reading it deletes it.
   *
   * The delete happens after the bytes are in hand but before the reply is
   * sent, so a job whose deletion fails never hands out a file it cannot
   * then remove -- the promise is "downloaded means deleted", and a
   * download that outran its own cleanup would break it silently.
   */
  app.get('/v1/jobs/:id/result', async (req: FastifyRequest, reply: FastifyReply) => {
    const id = paramId(req)
    if (!id) return reply.code(404).send(NOT_FOUND)
    const record = queue.status(id)
    if (!record) return reply.code(404).send(NOT_FOUND)

    if (record.status === 'queued' || record.status === 'running') {
      return reply.code(409).send({ error: 'The conversion has not finished yet.' })
    }
    const bytes = record.status === 'done' ? await storage.get(id, 'result') : null
    if (!bytes) return reply.code(404).send(NOT_FOUND)

    await storage.delete(id)

    const { contentType, filename } = RESULT[record.type]
    req.log.info(
      jobFields({ jobId: id, type: record.type, bytes: bytes.length, outcome: 'done' }),
      'result downloaded and deleted',
    )
    return reply
      .header('content-type', contentType)
      .header('content-disposition', `attachment; filename="${filename}"`)
      // A result is single-use; a cache holding it defeats the deletion.
      .header('cache-control', 'no-store')
      .send(Buffer.from(bytes))
  })

  /**
   * Purge, client-initiated.
   *
   * Always 204, including for an id that was never real. A DELETE that
   * 404'd on unknown ids would be an oracle for which ids exist, and the
   * caller has nothing to do differently either way.
   */
  app.delete('/v1/jobs/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const id = paramId(req)
    if (!id) return reply.code(204).send()
    queue.cancel(id)
    await storage.delete(id)
    queue.forget(id)
    return reply.code(204).send()
  })
}

function tooLarge(limit: number): string {
  return `That file is larger than the ${Math.round(limit / (1024 * 1024))} MB limit.`
}

/** Busboy's limit, however it surfaces: thrown by `toBuffer` or flagged on the stream. */
function isTooLarge(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'FST_REQ_FILE_TOO_LARGE'
}
