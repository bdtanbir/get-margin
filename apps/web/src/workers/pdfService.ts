import { PdfDocument, renderPage } from '@margin/pdf-core'
import type { PageGeometry } from '@margin/transform'

export type DocumentInfo = {
  pageCount: number
  geometries: PageGeometry[]
  needsPassword: boolean
}

export type RenderRequest = { id: number; page: number; scale: number }
export type RenderResult = { width: number; height: number; rgba: Uint8Array; page: number; scale: number }

/**
 * All PDF work for the app, with no knowledge of workers or Comlink.
 * Instantiated once inside pdf.worker.ts; unit-tested directly in Node.
 *
 * MuPDF is not safely reentrant, so callers must serialize: the worker's
 * single-threaded event loop provides that, and pdfClient never issues
 * overlapping render calls.
 */
export class PdfService {
  #doc: PdfDocument | undefined

  #info(): DocumentInfo {
    const doc = this.#doc
    if (!doc) throw new Error('no document open')
    const needsPassword = doc.needsPassword()
    // Geometry is unavailable until authentication succeeds.
    const geometries = needsPassword
      ? []
      : Array.from({ length: doc.pageCount }, (_, i) => doc.pageGeometry(i))
    return { pageCount: needsPassword ? 0 : doc.pageCount, geometries, needsPassword }
  }

  /**
   * Opens a new document, closing whatever was previously open.
   *
   * `bytes` is transferred (not copied) across the worker boundary by
   * pdfClient, which neuters the caller's ArrayBuffer — the main thread
   * must not read `bytes` again after this call resolves. Callers that need
   * the file's name, size, or hash must capture those before calling.
   */
  open(bytes: Uint8Array): DocumentInfo {
    this.close()
    this.#doc = PdfDocument.open(bytes)
    return this.#info()
  }

  authenticate(password: string): DocumentInfo {
    const doc = this.#doc
    if (!doc) throw new Error('no document open')
    if (!doc.authenticate(password)) throw new Error('Incorrect password')
    return this.#info()
  }

  /**
   * Renders one page. There is no cancellation here — see the long comment
   * on `PdfClient.render` in pdfClient.ts for why a per-request cancel
   * message cannot work over Comlink's synchronous, FIFO message channel.
   * The real abandonment mechanism is one layer up, in the viewport store's
   * `pump()`, which re-plans between renders instead of mid-render (MuPDF
   * cannot be interrupted once inside WASM, so between-renders is the
   * finest granularity available).
   */
  render(req: RenderRequest): RenderResult | null {
    const doc = this.#doc
    if (!doc) throw new Error('no document open')
    const { width, height, rgba } = renderPage(doc, req.page, req.scale)
    return { width, height, rgba, page: req.page, scale: req.scale }
  }

  close(): void {
    this.#doc?.close()
    this.#doc = undefined
  }
}
