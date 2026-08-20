import { describe, it, expect } from 'vitest'
import { Writable } from 'node:stream'
import { createLogger, jobFields } from '../src/plugins/logging.js'
import { newJobId } from '../src/storage/types.js'

/**
 * A stream the test can read back.
 *
 * These tests assert on the OUTPUT BYTES rather than on the shape of the
 * config, because the failure mode is silent: a logger that leaks a
 * filename produces a line that looks entirely normal. Checking that
 * `redact` was configured would pass while the leak happened.
 */
function capture() {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk))
      cb()
    },
  })
  return { stream, output: () => chunks.join('') }
}

const FILENAME = '2024-tax-return-jane-doe.pdf'
const CONTENTS = 'Gross income: 84,210. SSN 123-45-6789.'

describe('log redaction', () => {
  it('does not print a filename handed to it', () => {
    const { stream, output } = capture()
    const log = createLogger({ destination: stream })
    log.info({ filename: FILENAME }, 'upload received')
    expect(output()).not.toContain(FILENAME)
    expect(output()).not.toContain('jane-doe')
    expect(output()).toContain('[redacted]')
  })

  it('does not print a filename however it is spelled', () => {
    const { stream, output } = capture()
    const log = createLogger({ destination: stream })
    log.info({ fileName: FILENAME }, 'a')
    log.info({ originalname: FILENAME }, 'b')
    log.info({ file: { originalname: FILENAME } }, 'c')
    log.info({ upload: { filename: FILENAME } }, 'd')
    expect(output()).not.toContain(FILENAME)
  })

  it('does not print file contents', () => {
    const { stream, output } = capture()
    const log = createLogger({ destination: stream })
    log.info({ content: CONTENTS }, 'converted')
    log.info({ body: { data: CONTENTS } }, 'converted')
    expect(output()).not.toContain('84,210')
    expect(output()).not.toContain('123-45-6789')
  })

  it('does not print a whole payload', () => {
    const { stream, output } = capture()
    const log = createLogger({ destination: stream })
    log.info({ payload: { filename: FILENAME, content: CONTENTS, type: 'html-to-pdf' } }, 'job')
    expect(output()).not.toContain(FILENAME)
    expect(output()).not.toContain(CONTENTS)
  })

  /**
   * A URL carries the job id, which is the only credential for reading a
   * result. The route pattern is what is useful in a log; the concrete
   * path is a secret.
   */
  it('logs the route rather than the concrete URL', () => {
    const { stream, output } = capture()
    const log = createLogger({ destination: stream })
    const id = newJobId()
    log.info(
      { req: { method: 'GET', url: `/v1/jobs/${id}/result`, routeOptions: { url: '/v1/jobs/:id/result' } } },
      'request',
    )
    expect(output()).not.toContain(id)
    expect(output()).toContain('/v1/jobs/:id/result')
  })

  it('does not print request headers, which carry cookies and referrers', () => {
    const { stream, output } = capture()
    const log = createLogger({ destination: stream })
    log.info({ headers: { cookie: 'session=abc' }, req: { headers: { cookie: 'session=abc' } } }, 'x')
    expect(output()).not.toContain('session=abc')
  })

  /** A stack trace routinely contains the value that caused the throw. */
  it('does not print a stack trace', () => {
    const { stream, output } = capture()
    const log = createLogger({ destination: stream })
    const err = new Error('render failed')
    err.stack = `Error: render failed\n    at parse(${FILENAME})`
    log.error({ err }, 'job failed')
    expect(output()).not.toContain(FILENAME)
    expect(output()).toContain('render failed')
  })

  it('still prints what an operator actually needs', () => {
    const { stream, output } = capture()
    const log = createLogger({ destination: stream })
    const id = newJobId()
    log.info(
      jobFields({ jobId: id, type: 'html-to-pdf', bytes: 17_590, durationMs: 562, outcome: 'done' }),
      'job finished',
    )
    const line = output()
    expect(line).toContain(id)
    expect(line).toContain('html-to-pdf')
    expect(line).toContain('17590')
    expect(line).toContain('562')
    expect(line).toContain('done')
  })
})

describe('jobFields', () => {
  /**
   * The allowlist is the primary control, not the redaction config.
   * Anything outside the shape is DROPPED rather than censored, so it
   * never reaches the logger to be redacted in the first place.
   */
  it('drops everything outside the allowlist', () => {
    const id = newJobId()
    const fields = jobFields({
      jobId: id,
      type: 'html-to-pdf',
      bytes: 10,
      // @ts-expect-error -- the point of the test: a caller that tries.
      filename: FILENAME,
      contents: CONTENTS,
    })
    expect(fields).toEqual({ jobId: id, type: 'html-to-pdf', bytes: 10 })
    expect(JSON.stringify(fields)).not.toContain(FILENAME)
  })

  it('omits absent fields rather than emitting undefined', () => {
    const id = newJobId()
    expect(jobFields({ jobId: id, type: 'html-to-pdf' })).toEqual({ jobId: id, type: 'html-to-pdf' })
  })
})
