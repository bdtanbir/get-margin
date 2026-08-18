import * as mupdf from 'mupdf'
import type { PageGeometry } from '@margin/transform'
import { geometryFromPageObject, type RawObj } from './geometry.js'

export class PdfOpenError extends Error {
  constructor(cause: unknown) {
    super('Could not open this file as a PDF')
    this.name = 'PdfOpenError'
    this.cause = cause
  }
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] // "%PDF"

/** Spec §2.1 / §4: validate magic bytes, never the filename extension. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  // The header may be preceded by junk in tolerant readers; check the first 1KB.
  const limit = Math.min(bytes.length - PDF_MAGIC.length, 1024)
  for (let i = 0; i <= limit; i++) {
    if (PDF_MAGIC.every((b, k) => bytes[i + k] === b)) return true
  }
  return false
}

/**
 * Owns one open MuPDF document. Every other module in the app holds this
 * handle rather than a raw mupdf object, so lifetime and disposal live here.
 */
export class PdfDocument {
  #doc: mupdf.PDFDocument | undefined
  #geometryCache = new Map<number, PageGeometry>()

  private constructor(doc: mupdf.PDFDocument) {
    this.#doc = doc
  }

  static open(bytes: Uint8Array): PdfDocument {
    if (!looksLikePdf(bytes)) throw new PdfOpenError('missing %PDF header')
    try {
      const doc = mupdf.Document.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument
      return new PdfDocument(doc)
    } catch (e) {
      throw new PdfOpenError(e)
    }
  }

  #live(): mupdf.PDFDocument {
    if (!this.#doc) throw new Error('PdfDocument is closed')
    return this.#doc
  }

  get pageCount(): number {
    return this.#live().countPages()
  }

  needsPassword(): boolean {
    return this.#live().needsPassword()
  }

  /** Returns true if the password was accepted. */
  authenticate(password: string): boolean {
    // MuPDF returns 0 on failure, non-zero for various success flavours.
    return Boolean(this.#live().authenticatePassword(password))
  }

  pageGeometry(index: number): PageGeometry {
    const doc = this.#live()
    if (!Number.isInteger(index) || index < 0 || index >= doc.countPages()) {
      throw new RangeError(`page index ${index} out of range (0..${doc.countPages() - 1})`)
    }
    const cached = this.#geometryCache.get(index)
    if (cached) return cached

    const page = doc.loadPage(index)
    try {
      const obj = page.getObject() as unknown as RawObj
      const geom = geometryFromPageObject(obj)
      this.#geometryCache.set(index, geom)
      return geom
    } finally {
      page.destroy()
    }
  }

  /** Internal: hands the raw document to sibling modules in this package. */
  _raw(): mupdf.PDFDocument {
    return this.#live()
  }

  close(): void {
    const doc = this.#doc
    this.#doc = undefined
    this.#geometryCache.clear()
    doc?.destroy()
  }
}

/**
 * Free function form of `PdfDocument#pageGeometry`, listed separately in the
 * task interface. Kept as a thin delegate — the method is the source of
 * truth (caching lives there) — so call sites can use either form.
 */
export function readPageGeometry(doc: PdfDocument, index: number): PageGeometry {
  return doc.pageGeometry(index)
}
