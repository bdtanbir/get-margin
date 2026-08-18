import * as mupdf from 'mupdf'
import { PdfDocument } from '../engine.js'

/**
 * Open a document for writing and guarantee it is closed.
 *
 * Disposal is a CORRECTNESS requirement here, not hygiene: Phase 0 measured
 * that omitting .destroy() does not leak gradually but hard-crashes the WASM
 * heap with `malloc failed` inside a single few-hundred-page sweep
 * (docs/findings/00-engine-facts.md). Centralising the try/finally here is
 * why no object writer can forget it.
 */
export function withDocument<T>(
  bytes: Uint8Array,
  fn: (doc: PdfDocument, raw: mupdf.PDFDocument) => T,
): T {
  const doc = PdfDocument.open(bytes)
  try {
    return fn(doc, doc._raw())
  } finally {
    doc.close()
  }
}

/** Load one page and guarantee it is destroyed. Same reasoning as above. */
export function withPage<T>(
  raw: mupdf.PDFDocument,
  index: number,
  fn: (page: mupdf.PDFPage) => T,
): T {
  const page = raw.loadPage(index)
  try {
    return fn(page)
  } finally {
    page.destroy()
  }
}

/**
 * 'compress' shrinks streams; 'garbage=compact' drops objects the edits
 * orphaned and renumbers the xref. Spec 2.1's export row names this exact
 * option string.
 */
export const SAVE_OPTIONS = 'compress,garbage=compact'
