import * as mupdf from 'mupdf'
import { withDocument, withPage, SAVE_OPTIONS } from './session.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument, type EditObject, type ObjectKind } from './types.js'
import type { PageGeometry } from '@margin/transform'
import { writeShape } from './objects/shape.js'
import { writeWhiteout } from './objects/whiteout.js'
import { writeText } from './objects/text.js'
import { FontRegistry, createMeasurer, type FontProvider } from './fonts.js'
import { writeImage } from './objects/image.js'
import { createXObjectCache, type XObjectCache } from './xobject.js'
import { writeInk } from './objects/ink.js'
import { writeLink } from './objects/link.js'

export type WriteContext = {
  raw: mupdf.PDFDocument
  page: mupdf.PDFPage
  geometry: PageGeometry
  /**
   * Task 31 widened this context. Both members are always present -- a
   * document with no text objects simply never touches them -- so every
   * writer written before Task 31 stays valid unchanged.
   */
  fonts: FontRegistry
  /** Advance width of `text` in points. See createMeasurer in fonts.ts. */
  measure: (text: string, family: string, size: number) => number
  /**
   * Task 32, the third and final widening. Embed-once memo for image
   * XObjects, keyed by payload -- see xobject.ts.
   */
  xobject: XObjectCache
}

export type ObjectWriter = (ctx: WriteContext, object: EditObject) => void

/**
 * One writer per ObjectKind. Tasks 29-35 and 38 each register their kind
 * here; this map is deliberately the ONLY place a kind becomes a drawing
 * operation, so an unhandled kind is a loud startup-time gap rather than a
 * silently-dropped object in someone's exported document.
 */
export const WRITERS: Partial<Record<ObjectKind, ObjectWriter>> = {}

// Task 29. All four shapes share one writer -- they differ only in the path
// they emit, not in how colour, opacity, or the painting operator are
// resolved.
WRITERS.rect = writeShape
WRITERS.ellipse = writeShape
WRITERS.line = writeShape
WRITERS.arrow = writeShape

// Task 30. Covers content; does not remove it -- see objects/whiteout.ts.
WRITERS.whiteout = writeWhiteout

// Task 31. Content-stream operators, NOT a FreeText annotation: Phase 0
// measured that FreeText silently ignores any font outside the standard 14,
// and every bundled face is non-base-14.
WRITERS.text = writeText

// Task 32. Drawn as an XObject in the content stream, not an annotation:
// an image is page content, and content is what survives flattening.
WRITERS.image = writeImage

// Task 33. A NATIVE Ink annotation, not content-stream paths: ink stays
// selectable and removable in other PDF tools (the semantic split, spec 0).
WRITERS.ink = writeInk

// Task 34. page.createLink (fz_link), NOT createAnnotation('Link') -- see
// objects/link.ts for what Phase 0 measured about the difference.
WRITERS.link = writeLink

// Task 35. A signature is a raster placed on the page, so it exports through
// the SAME writer as an image rather than a near-copy of it -- the two differ
// only in provenance and in which inspector fields they offer. Sharing the
// writer also means they share the embed-once XObject cache, so one signature
// applied to every page of a contract embeds once.
WRITERS.signature = writeImage

/**
 * Build the exported document.
 *
 * A pure function of its inputs: it opens a SECOND document from the
 * pristine source bytes and never touches the one being rendered, which is
 * what keeps spec 1.5's deferred-bake invariant true. Runs entirely in the
 * worker, and is fully testable in Node with no browser.
 */
export type ReplayOptions = {
  /**
   * Font bytes by family name, for text objects. Optional: a document with
   * no text needs none, and resolving one that was never supplied throws by
   * name rather than substituting a face silently (see FontRegistry).
   */
  fonts?: FontProvider
}

export function replay(
  sourceBytes: Uint8Array,
  editDoc: EditDocument,
  opts: ReplayOptions = {},
): Uint8Array {
  if (editDoc.version > EDIT_DOCUMENT_VERSION) {
    throw new Error(
      `This document was edited by a newer version of get-margin ` +
        `(schema version ${editDoc.version}, this build understands ${EDIT_DOCUMENT_VERSION}).`,
    )
  }

  const provider: FontProvider = opts.fonts ?? new Map()
  const measure = createMeasurer(provider)

  return withDocument(sourceBytes, (doc, raw) => {
    // One registry per replay call, so a family used on five pages is parsed
    // and embedded once rather than five times.
    const fonts = new FontRegistry(raw, provider)
    // Per document, not per page: the SAME image placed on ten pages is one
    // embedded stream referenced ten times.
    const xobject = createXObjectCache()

    // Group objects by page once, then draw each page's objects in z order.
    // Sorting per page rather than globally keeps stacking well-defined
    // within a page without imposing a meaningless order across pages.
    const byPage = new Map<string, EditObject[]>()
    for (const object of Object.values(editDoc.objects)) {
      const list = byPage.get(object.pageId)
      if (list) list.push(object)
      else byPage.set(object.pageId, [object])
    }

    for (const pageId of editDoc.pageOrder) {
      const objects = byPage.get(pageId)
      if (!objects || objects.length === 0) continue

      const sourceIndex = editDoc.pages[pageId]?.sourceIndex
      if (sourceIndex === undefined) {
        throw new Error(`edit document references unknown page "${pageId}"`)
      }

      objects.sort((a, b) => a.z - b.z)
      const geometry = doc.pageGeometry(sourceIndex)

      withPage(raw, sourceIndex, (page) => {
        for (const object of objects) {
          const writer = WRITERS[object.kind]
          if (!writer) {
            // Fail the WHOLE export. A partial PDF that silently dropped a
            // signature is worse than a failed download, because the user
            // will not notice the omission.
            throw new Error(
              `no writer registered for object kind "${object.kind}" (object ${object.id})`,
            )
          }
          writer({ raw, page, geometry, fonts, measure, xobject }, object)
        }
      })
    }

    return raw.saveToBuffer(SAVE_OPTIONS).asUint8Array()
  })
}

export { withDocument, withPage, SAVE_OPTIONS } from './session.js'
export { toAnnotSpace, toContentSpace, num } from './coords.js'
export { appendContent, addResource, fillColor, strokeColor, alphaState } from './content.js'
export { writeShape } from './objects/shape.js'
export { writeWhiteout } from './objects/whiteout.js'
export { writeText, ASCENT_RATIO, LINE_HEIGHT } from './objects/text.js'
export { FontRegistry, createMeasurer, pdfString, type FontProvider } from './fonts.js'
export { writeImage } from './objects/image.js'
export { createXObjectCache, type XObjectCache } from './xobject.js'
export { writeInk } from './objects/ink.js'
export { writeLink } from './objects/link.js'
