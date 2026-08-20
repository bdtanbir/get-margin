import { chromium, type Browser, type BrowserContext } from 'playwright'
import type { Converter, ConvertOptions } from './types.js'
import { ConversionTimeout } from './types.js'

/** Long enough for a large document, short enough that a stuck one is noticed. */
export const DEFAULT_TIMEOUT_MS = 30_000

export type HtmlConverterOptions = {
  timeoutMs?: number
  /** A4 by default. The dialog does not offer a choice yet; the plumbing is here. */
  format?: 'A4' | 'Letter'
  margin?: string
}

/**
 * HTML to PDF, through Chromium.
 *
 * The engine is one this repository already ships for its end-to-end
 * tests, so this converter adds no deployment weight the project was not
 * already carrying -- which is most of why it is the one converter Phase 7
 * implements (`PHASE-7-DESIGN.md` §0).
 *
 * Two properties matter more than the rendering:
 *
 * **JavaScript is disabled.** The input is an attacker-controlled document.
 * A browser engine executing it is a browser engine executing whatever the
 * uploader wrote, inside our infrastructure.
 *
 * **The network is dead.** Every request the page makes is aborted,
 * including the ones a perfectly innocent document makes. Converting a
 * document must not fetch a tracking pixel: the fetch tells a third party
 * that this document was converted, at this time, from our address --
 * which is exactly the disclosure the rest of this product exists to
 * avoid. It also closes SSRF, since a document asking for
 * `http://169.254.169.254/` gets nothing.
 *
 * Both are enforced at the browser context, not by scrubbing the HTML.
 * Sanitising markup is a parser-versus-parser game that the sanitiser
 * eventually loses; refusing to execute and refusing to connect are
 * properties of the runtime, and there is no markup that talks the runtime
 * out of them.
 */
export class HtmlConverter implements Converter {
  readonly type = 'html-to-pdf' as const

  constructor(private readonly options: HtmlConverterOptions = {}) {}

  async convert(input: Uint8Array, options: ConvertOptions = {}): Promise<Uint8Array> {
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const html = new TextDecoder('utf-8', { fatal: false }).decode(input)

    let browser: Browser | undefined
    let timer: NodeJS.Timeout | undefined
    let timedOut = false

    try {
      browser = await chromium.launch({
        args: [
          // Belt to the context's braces: even if a page somehow reached
          // the network, it would not reach another origin's data.
          '--disable-background-networking',
          '--disable-sync',
          '--no-default-browser-check',
          '--no-first-run',
        ],
      })

      /**
       * The wall clock, and what it does when it fires.
       *
       * Closing the BROWSER, not rejecting a promise. A promise that
       * rejects while Chromium is still chewing on the document leaves the
       * process running and the memory held -- the timeout would report a
       * failure without causing one. Closing the browser is what makes
       * every pending operation below fail, which is the point.
       */
      const held = browser
      timer = setTimeout(() => {
        timedOut = true
        void held.close().catch(() => {})
      }, timeoutMs)

      const context = await browser.newContext({
        javaScriptEnabled: false,
        // No cookies, no storage, no service workers: a fresh context per
        // conversion means one document can never see another's state.
        serviceWorkers: 'block',
      })
      await blockAllRequests(context)

      const page = await context.newPage()
      options.report?.(0.3)

      // `setContent`, not a navigation: the document is never given an
      // origin, a URL, or a base a relative reference could resolve
      // against. `domcontentloaded` rather than `load` because `load`
      // waits for subresources that are all being aborted anyway.
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      options.report?.(0.6)

      const pdf = await page.pdf({
        format: this.options.format ?? 'A4',
        printBackground: true,
        margin: marginOf(this.options.margin ?? '12mm'),
      })
      options.report?.(1)

      return new Uint8Array(pdf.buffer, pdf.byteOffset, pdf.byteLength)
    } catch (err) {
      // The close above makes the real failure some internal "target
      // closed" message. Reporting THAT would tell a user their document
      // was malformed when in fact it was slow.
      if (timedOut) throw new ConversionTimeout(timeoutMs)
      throw err
    } finally {
      if (timer) clearTimeout(timer)
      // Closing twice is fine, and not closing leaks a Chromium per job.
      await browser?.close().catch(() => {})
    }
  }
}

/**
 * Aborts every request the page makes.
 *
 * `**` matches every scheme, so this covers `http`, `https`, `ws`, `file`,
 * and `data` alike. Aborting rather than fulfilling with an empty body:
 * an empty 200 tells the page the resource exists, and some documents
 * behave differently on that.
 */
async function blockAllRequests(context: BrowserContext): Promise<void> {
  await context.route('**', (route) => route.abort())
}

function marginOf(size: string) {
  return { top: size, right: size, bottom: size, left: size }
}
