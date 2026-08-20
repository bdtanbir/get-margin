import { describe, it, expect, vi } from 'vitest'
import {
  scrub, errorType, errorMessage, safeName, safeComponent, MAX_MESSAGE, REJECTED,
} from '@/lib/telemetry/scrub'
import { Reporter, httpTransport, telemetryConfigured } from '@/lib/telemetry/reporter'
import type { TelemetryEvent } from '@/lib/telemetry/types'

const ENDPOINT = 'https://telemetry.example'

/** Named so a leak is unmistakable, and shaped like the thing §4 is about. */
const FILENAME = '2024-tax-return-jane-doe.pdf'

function collector() {
  const sent: TelemetryEvent[][] = []
  return {
    sent,
    transport: async (events: TelemetryEvent[]) => {
      sent.push(events)
    },
    /** What would actually go over the wire. Assertions read THIS. */
    bytes: () => JSON.stringify(sent),
  }
}

const allowed = (options: Partial<ConstructorParameters<typeof Reporter>[0]> = {}) => {
  const c = collector()
  const reporter = new Reporter({
    endpoint: ENDPOINT,
    consent: () => true,
    transport: c.transport,
    ...options,
  })
  return { reporter, c }
}

describe('scrub', () => {
  /**
   * `lib/pageRanges.ts` throws `"${text}" is not a page range.` with
   * whatever the user typed. That is not a hypothetical: it is the first
   * message anyone would hit while poking at the split dialog.
   */
  it('removes what a user typed, even when the message quotes it', () => {
    expect(scrub('"2024-tax-return" is not a page range.')).not.toContain('tax-return')
    expect(scrub("'my secret note' could not be parsed")).not.toContain('secret')
  })

  it('removes filenames whatever the extension', () => {
    for (const name of [FILENAME, 'Q3 results.xlsx', 'passport-scan.JPEG', 'notes.txt']) {
      const out = scrub(`Could not open ${name} for reading`)
      expect(out, name).toContain('[file]')
      expect(out, name).not.toContain(name)
    }
  })

  it('removes paths, URLs, emails and long tokens', () => {
    expect(scrub('failed at /Users/jane/Documents/taxes/return.pdf')).not.toContain('jane')
    expect(scrub('failed at C:\\Users\\jane\\return.pdf')).not.toContain('jane')
    expect(scrub('POST https://example.com/upload?name=jane')).not.toContain('jane')
    expect(scrub('mail jane.doe@example.com failed')).not.toContain('jane.doe')
    expect(scrub(`job ${'A'.repeat(43)} expired`)).toContain('[token]')
  })

  it('keeps a message that carries no user data readable', () => {
    expect(scrub('The document could not be rendered.')).toBe(
      'The document could not be rendered.',
    )
    expect(scrub('unexpected pixmap layout: 12 bytes for 4x4')).toContain('pixmap layout')
  })

  it('collapses whitespace and truncates prose', () => {
    expect(scrub('a\n\n  b')).toBe('a b')
    const long = scrub('x'.repeat(500))
    expect(long.length).toBeLessThanOrEqual(MAX_MESSAGE + 1)
  })

  it('yields nothing for a non-string', () => {
    expect(scrub(undefined)).toBe('')
    expect(scrub({ file: FILENAME })).toBe('')
  })
})

describe('errorType and errorMessage', () => {
  it('takes the type and never the stack', () => {
    const err = new TypeError('boom')
    expect(errorType(err)).toBe('TypeError')
    // The stack is full of paths; it is simply never read.
    expect(JSON.stringify({ t: errorType(err), m: errorMessage(err) })).not.toContain('.ts')
  })

  /** A thrown value can be anything, including a string built from the document. */
  it('refuses to stringify a thrown non-Error', () => {
    expect(errorType(FILENAME)).toBe('NonError')
    expect(errorMessage(FILENAME)).toBe('')
    expect(errorMessage({ name: FILENAME })).toBe('')
  })
})

describe('safeName and safeComponent', () => {
  /**
   * The reason these validate instead of scrubbing: a scrubber cannot tell
   * an event name with a dot from a filename, because they are the same
   * shape. Colons separate the parts of a name here precisely so a dot can
   * be rejected outright.
   */
  it('accepts identifiers and rejects anything filename-shaped', () => {
    expect(safeName('export:pdf')).toBe('export:pdf')
    expect(safeName('redact')).toBe('redact')
    expect(safeName('export_images')).toBe('export_images')

    expect(safeName(FILENAME)).toBe(REJECTED)
    expect(safeName('report.pdf')).toBe(REJECTED)
    expect(safeName('/Users/jane/a')).toBe(REJECTED)
    expect(safeName('x'.repeat(60))).toBe(REJECTED)
    expect(safeName(undefined)).toBe(REJECTED)
  })

  it('accepts component names and rejects the rest', () => {
    expect(safeComponent('CompressDialog')).toBe('CompressDialog')
    expect(safeComponent('TopBar')).toBe('TopBar')

    expect(safeComponent(FILENAME)).toBe(REJECTED)
    expect(safeComponent('Compress Dialog')).toBe(REJECTED)
    expect(safeComponent(42)).toBe(REJECTED)
  })
})

describe('Reporter: when it is allowed to send', () => {
  it('sends nothing with no endpoint configured, however enthusiastic the consent', async () => {
    const c = collector()
    const reporter = new Reporter({ endpoint: '', consent: () => true, transport: c.transport })
    reporter.reportError({ name: 'export-failed', component: 'TopBar', error: new Error('x') })
    reporter.countUsage('export:pdf')
    await reporter.flush()

    expect(reporter.enabled).toBe(false)
    expect(c.sent).toEqual([])
    expect(telemetryConfigured('')).toBe(false)
  })

  it('sends nothing when consent is withheld, however configured the endpoint', async () => {
    const c = collector()
    const reporter = new Reporter({ endpoint: ENDPOINT, consent: () => false, transport: c.transport })
    reporter.reportError({ name: 'export-failed', component: 'TopBar', error: new Error('x') })
    await reporter.flush()
    expect(c.sent).toEqual([])
  })

  /** Consent can be withdrawn between queueing and sending. The later answer wins. */
  it('sends nothing when consent is withdrawn before the flush', async () => {
    const c = collector()
    let agreed = true
    const reporter = new Reporter({
      endpoint: ENDPOINT,
      consent: () => agreed,
      transport: c.transport,
    })
    reporter.reportError({ name: 'export-failed', component: 'TopBar', error: new Error('x') })
    agreed = false
    await reporter.flush()
    expect(c.sent).toEqual([])
  })

  it('sends once both conditions hold', async () => {
    const { reporter, c } = allowed()
    reporter.reportError({ name: 'export-failed', component: 'TopBar', error: new Error('nope') })
    await reporter.flush()
    expect(c.sent).toHaveLength(1)
    expect(c.sent[0]![0]).toMatchObject({
      kind: 'error',
      name: 'export-failed',
      component: 'TopBar',
      errorType: 'Error',
      message: 'nope',
    })
  })
})

/**
 * The tests that matter.
 *
 * The failure mode is silent -- a payload carrying a filename looks
 * exactly like one that does not -- so these read the serialised bytes
 * rather than checking that scrubbing was called. Same discipline as the
 * API's logging suite.
 */
describe('Reporter: what reaches the wire', () => {
  it('never carries a filename, whichever field it was pushed into', async () => {
    const { reporter, c } = allowed()

    reporter.reportError({
      name: FILENAME,
      component: FILENAME,
      error: new Error(`Could not open ${FILENAME}`),
    })
    reporter.countUsage(FILENAME)
    await reporter.flush()

    const wire = c.bytes()
    expect(wire).not.toContain(FILENAME)
    expect(wire).not.toContain('tax-return')
    expect(wire).not.toContain('jane')
  })

  it('never carries a stack, a path, or a document', async () => {
    const { reporter, c } = allowed()
    const err = new Error('failed reading /Users/jane/Documents/return.pdf')
    reporter.reportError({ name: 'open-failed', component: 'DropZone', error: err })
    await reporter.flush()

    const wire = c.bytes()
    expect(wire).not.toContain('/Users/jane')
    expect(wire).not.toContain('return.pdf')
    // The stack would name this test file; it is never read.
    expect(wire).not.toContain('telemetry.test')
  })

  /**
   * A count cannot describe a document. Usage is aggregated before it
   * leaves rather than sent one event per action, so what a receiver gets
   * is "this feature was used four times" and not a timeline.
   */
  it('sends usage as counts, with no identifiers and no timestamps', async () => {
    const { reporter, c } = allowed()
    reporter.countUsage('export:pdf')
    reporter.countUsage('export:pdf')
    reporter.countUsage('redact')
    await reporter.flush()

    const events = c.sent[0]!
    expect(events).toEqual(
      expect.arrayContaining([
        { schema: 1, kind: 'usage', name: 'export:pdf', count: 2 },
        { schema: 1, kind: 'usage', name: 'redact', count: 1 },
      ]),
    )
    // Nothing time-shaped, nothing id-shaped.
    const wire = c.bytes()
    expect(wire).not.toMatch(/\b\d{13}\b/)
    expect(wire).not.toContain('sessionId')
    expect(wire).not.toContain('userId')
  })

  it('carries a schema version so a receiver can reject what it cannot read', async () => {
    const { reporter, c } = allowed()
    reporter.reportError({ name: 'x', component: 'y', error: new Error('z') })
    await reporter.flush()
    expect(c.sent[0]![0]!.schema).toBe(1)
  })

  it('holds nothing after a flush, successful or not', async () => {
    const failing = new Reporter({
      endpoint: ENDPOINT,
      consent: () => true,
      transport: async () => {
        throw new Error('network down')
      },
    })
    failing.reportError({ name: 'x', component: 'y', error: new Error('z') })
    // A failed send must not be retried: a queue waiting for a network is a
    // store of user-adjacent data this module refuses to keep.
    await expect(failing.flush()).resolves.toBeUndefined()
    expect(failing.pending()).toEqual([])
  })
})

describe('httpTransport', () => {
  it('posts events without credentials', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }))
    await httpTransport(ENDPOINT, fetchFn as unknown as typeof fetch)([
      { schema: 1, kind: 'usage', name: 'export:pdf', count: 1 },
    ])

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${ENDPOINT}/v1/events`)
    // No session, because a session would make these reports linkable.
    expect(init.credentials).toBe('omit')
    expect(String(init.body)).toContain('export:pdf')
  })
})
