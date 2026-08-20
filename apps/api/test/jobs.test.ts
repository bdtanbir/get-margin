import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { createLogger } from '../src/plugins/logging.js'
import { createApi } from '../src/server.js'
import type { MemoryQueue } from '../src/jobs/memoryQueue.js'
import type { StorageAdapter } from '../src/storage/types.js'
import { newJobId } from '../src/storage/types.js'

/**
 * The API is exercised through Fastify's `inject`: no port is bound, so
 * the suite is deterministic and can run in parallel with everything else.
 * The routing, the multipart parsing, the error handler and the status
 * codes are all real -- only the socket is not.
 */

const BOUNDARY = '----marginTestBoundary'
const HTML = '<!DOCTYPE html><html><body><h1>Hello</h1></body></html>'
/** What the fake converter returns. Real `%PDF-` bytes are Task 101's job. */
const PDF = new TextEncoder().encode('%PDF-1.7\nfake\n%%EOF\n')

/**
 * A multipart body, built by hand.
 *
 * `filename` defaults to something that would be very obvious in a
 * response or a log if it ever escaped -- several tests search the output
 * for it.
 */
function multipart(opts: {
  type?: string | null
  file?: { bytes: Uint8Array | string; filename?: string; contentType?: string } | null
  extraFile?: { bytes: Uint8Array | string; filename?: string } | null
  /** Field before file, or after. Both must work. */
  fieldLast?: boolean
}): { payload: Buffer; headers: Record<string, string> } {
  const chunks: Buffer[] = []
  const field = (name: string, value: string) =>
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    )
  const file = (name: string, f: { bytes: Uint8Array | string; filename?: string; contentType?: string }) => {
    const body = typeof f.bytes === 'string' ? Buffer.from(f.bytes) : Buffer.from(f.bytes)
    return Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; ` +
          `filename="${f.filename ?? SECRET_FILENAME}"\r\n` +
          `Content-Type: ${f.contentType ?? 'text/html'}\r\n\r\n`,
      ),
      body,
      Buffer.from('\r\n'),
    ])
  }

  if (opts.type !== null && !opts.fieldLast) chunks.push(field('type', opts.type ?? 'html-to-pdf'))
  if (opts.file !== null) chunks.push(file('file', opts.file ?? { bytes: HTML }))
  if (opts.extraFile) chunks.push(file('file', opts.extraFile))
  if (opts.type !== null && opts.fieldLast) chunks.push(field('type', opts.type ?? 'html-to-pdf'))
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`))

  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  }
}

/** Named so a leak is unmistakable, and shaped like the thing §4 is about. */
const SECRET_FILENAME = '2024-tax-return-jane-doe.html'

let root: string
let app: FastifyInstance
let storage: StorageAdapter
let queue: MemoryQueue
let logLines: string[]
let logger: ReturnType<typeof createLogger>
/** Flipped by a test that wants the converter to fail. */
let converterThrows: string | null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'margin-api-'))
  converterThrows = null
  logLines = []
  logger = createLogger({
    destination: new Writable({
      write(chunk, _enc, cb) {
        logLines.push(String(chunk))
        cb()
      },
    }),
  })
  const api = await createApi({
    storageRoot: root,
    logger,
    // No interval: a sweeper timer outliving the file would hang the run.
    sweep: false,
    handlers: {
      'html-to-pdf': async () => {
        if (converterThrows) throw new Error(converterThrows)
        return PDF
      },
    },
  })
  app = api.app
  storage = api.storage
  queue = api.queue
})

afterEach(async () => {
  await app.close()
  await rm(root, { recursive: true, force: true })
})

/** Posts a job and waits for the in-process queue to finish it. */
async function submit(opts: Parameters<typeof multipart>[0] = {}) {
  const { payload, headers } = multipart(opts)
  const res = await app.inject({ method: 'POST', url: '/v1/jobs', payload, headers })
  if (res.statusCode === 202) await queue.drain()
  return res
}

describe('POST /v1/jobs', () => {
  it('accepts a job and answers with an id and a status url', async () => {
    const res = await submit()
    expect(res.statusCode).toBe(202)
    const body = res.json()
    expect(body.jobId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(body.statusUrl).toBe(`/v1/jobs/${body.jobId}`)
  })

  it('reads the type whether it arrives before or after the file', async () => {
    const res = await submit({ fieldLast: true })
    expect(res.statusCode).toBe(202)
  })

  /**
   * The filename is user data (§4) and frequently IS the sensitive thing.
   * It is never read from the upload, so there is nothing to echo -- this
   * asserts the whole response body and every log line the request wrote.
   */
  it('never echoes the uploaded filename, in the response or in the log', async () => {
    const res = await submit()
    expect(res.body).not.toContain(SECRET_FILENAME)
    expect(res.body).not.toContain('tax-return')
    expect(logLines.join('')).not.toContain(SECRET_FILENAME)
    expect(logLines.join('')).not.toContain('tax-return')
  })

  it('does not write the filename into storage either', async () => {
    const { jobId } = (await submit()).json()
    const entries = await readdir(root)
    expect(entries).toEqual([jobId])
    // Slots are fixed names; nothing the user chose is on the path.
    expect(await readdir(join(root, jobId))).not.toContain(SECRET_FILENAME)
  })

  it('rejects an unknown job type', async () => {
    const res = await submit({ type: 'office-to-pdf' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('Unsupported')
  })

  it('rejects a request with no type at all', async () => {
    const res = await submit({ type: null })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a request with no file', async () => {
    const res = await submit({ file: null })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a second file rather than silently converting the first', async () => {
    const res = await submit({ extraFile: { bytes: HTML } })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('refuses a body that is not multipart', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      payload: { type: 'html-to-pdf' },
    })
    expect(res.statusCode).toBe(415)
  })
})

describe('magic-byte validation', () => {
  /**
   * The extension says HTML and the bytes say PDF. The bytes win, and the
   * refusal happens BEFORE anything is written -- a rejected file must
   * never have existed on our disk, which is what the storage assertion
   * below is for.
   */
  it('rejects a PDF wearing an .html filename, and stores nothing', async () => {
    const res = await submit({ file: { bytes: '%PDF-1.7\nnot html', filename: 'page.html' } })
    expect(res.statusCode).toBe(415)
    expect(res.json().error).toContain('PDF')
    expect(await readdir(root)).toEqual([])
  })

  it('rejects a zip, a PNG and an executable', async () => {
    for (const bytes of [
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10]),
      new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1]),
    ]) {
      const res = await submit({ file: { bytes } })
      expect(res.statusCode).toBe(415)
    }
    expect(await readdir(root)).toEqual([])
  })

  it('rejects binary that matches no signature, by its NUL bytes', async () => {
    const res = await submit({ file: { bytes: new Uint8Array([0x3c, 0x00, 0x3e, 0x00]) } })
    expect(res.statusCode).toBe(415)
    expect(res.json().error).toContain('binary')
  })

  it('rejects prose that never opens a tag', async () => {
    const res = await submit({ file: { bytes: 'Dear Jane, please find attached...' } })
    expect(res.statusCode).toBe(415)
  })

  it('accepts markup behind a BOM and leading whitespace', async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`\n\n  ${HTML}`)])
    const res = await submit({ file: { bytes: new Uint8Array(withBom) } })
    expect(res.statusCode).toBe(202)
  })

  it('rejects an empty file', async () => {
    const res = await submit({ file: { bytes: '' } })
    expect(res.statusCode).toBe(400)
  })
})

describe('the size cap', () => {
  it('rejects an upload past the limit and stores nothing', async () => {
    const small = await createApi({ storageRoot: root, sweep: false, maxUploadBytes: 1024, logger })
    const big = '<html>' + 'a'.repeat(4096) + '</html>'
    const { payload, headers } = multipart({ file: { bytes: big } })
    const res = await small.app.inject({ method: 'POST', url: '/v1/jobs', payload, headers })
    expect(res.statusCode).toBe(413)
    expect(await readdir(root)).toEqual([])
    await small.app.close()
  })
})

describe('GET /v1/jobs/:id', () => {
  it('reports done with a result ready once the converter has run', async () => {
    const { jobId } = (await submit()).json()
    const res = await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ jobId, type: 'html-to-pdf', status: 'done', resultReady: true })
  })

  it('reports a failure with a reason, and not with the file', async () => {
    converterThrows = 'The document could not be rendered.'
    const { jobId } = (await submit()).json()
    const body = (await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}` })).json()
    expect(body.status).toBe('failed')
    expect(body.error).toBe('The document could not be rendered.')
    expect(body.resultReady).toBe(false)
  })

  it('is 404 for an id that never existed', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/jobs/${newJobId()}` })
    expect(res.statusCode).toBe(404)
  })

  /**
   * A malformed id and an unknown one answer identically. A different
   * status or a different sentence for "that is not even an id" is only
   * ever useful to someone enumerating.
   */
  it('answers a malformed id exactly as it answers an unknown one', async () => {
    const unknown = await app.inject({ method: 'GET', url: `/v1/jobs/${newJobId()}` })
    const malformed = await app.inject({ method: 'GET', url: '/v1/jobs/not-an-id' })
    expect(malformed.statusCode).toBe(unknown.statusCode)
    expect(malformed.body).toBe(unknown.body)
  })
})

describe('GET /v1/jobs/:id/result', () => {
  it('returns the converted bytes with a fixed, safe filename', async () => {
    const { jobId } = (await submit()).json()
    const res = await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}/result` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toBe('attachment; filename="converted.pdf"')
    expect(res.headers['content-disposition']).not.toContain('tax-return')
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
  })

  /** Deletion path 1 of 4: the result is read once and is then gone. */
  it('deletes the result on a successful read, so a second read is 404', async () => {
    const { jobId } = (await submit()).json()
    expect((await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}/result` })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}/result` })).statusCode).toBe(404)
    expect(await readdir(root)).toEqual([])
  })

  /**
   * After the download the job is not an error and not a mystery: the file
   * was deleted, exactly as promised.
   */
  it('reports expired, not failed, once the result has been downloaded', async () => {
    const { jobId } = (await submit()).json()
    await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}/result` })
    const body = (await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}` })).json()
    expect(body.status).toBe('expired')
    expect(body.resultReady).toBe(false)
  })

  it('is 404 for a failed job', async () => {
    converterThrows = 'nope'
    const { jobId } = (await submit()).json()
    const res = await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}/result` })
    expect(res.statusCode).toBe(404)
  })
})

describe('deletion', () => {
  /**
   * The load-bearing one. Deletion is not contingent on the job going
   * well: a conversion that threw still had a user's file on our disk.
   */
  it('deletes the input of a FAILED job', async () => {
    converterThrows = 'the converter fell over'
    const { jobId } = (await submit()).json()
    expect(await storage.get(jobId, 'input')).toBeNull()
    expect(await readdir(root)).toEqual([])
  })

  it('deletes the input of a successful job as soon as the result exists', async () => {
    const { jobId } = (await submit()).json()
    expect(await storage.get(jobId, 'input')).toBeNull()
    expect(await storage.get(jobId, 'result')).not.toBeNull()
  })

  it('purges on DELETE, and says nothing about whether the id was real', async () => {
    const { jobId } = (await submit()).json()
    const purge = await app.inject({ method: 'DELETE', url: `/v1/jobs/${jobId}` })
    expect(purge.statusCode).toBe(204)
    expect(await readdir(root)).toEqual([])
    const unknown = await app.inject({ method: 'DELETE', url: `/v1/jobs/${newJobId()}` })
    expect(unknown.statusCode).toBe(purge.statusCode)
    expect(unknown.body).toBe(purge.body)
  })

  /** A purged id must read as one that never existed, not as `expired`. */
  it('makes a purged job indistinguishable from an unknown one', async () => {
    const { jobId } = (await submit()).json()
    await app.inject({ method: 'DELETE', url: `/v1/jobs/${jobId}` })
    const purged = await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}` })
    const unknown = await app.inject({ method: 'GET', url: `/v1/jobs/${newJobId()}` })
    expect(purged.statusCode).toBe(404)
    expect(purged.body).toBe(unknown.body)
  })
})
