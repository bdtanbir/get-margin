import * as mupdf from 'mupdf'
import { withDocument, withPage, SAVE_OPTIONS } from './session.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument, type EditObject, type ObjectKind } from './types.js'
import type { PageGeometry } from '@margin/transform'
import { writeShape } from './objects/shape.js'
import { writeWhiteout } from './objects/whiteout.js'

export type WriteContext = {
  raw: mupdf.PDFDocument
  page: mupdf.PDFPage
  geometry: PageGeometry
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

/**
 * Build the exported document.
 *
 * A pure function of its inputs: it opens a SECOND document from the
 * pristine source bytes and never touches the one being rendered, which is
 * what keeps spec 1.5's deferred-bake invariant true. Runs entirely in the
 * worker, and is fully testable in Node with no browser.
 */
export function replay(sourceBytes: Uint8Array, editDoc: EditDocument): Uint8Array {
  if (editDoc.version > EDIT_DOCUMENT_VERSION) {
    throw new Error(
      `This document was edited by a newer version of get-margin ` +
        `(schema version ${editDoc.version}, this build understands ${EDIT_DOCUMENT_VERSION}).`,
    )
  }

  return withDocument(sourceBytes, (doc, raw) => {
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
          writer({ raw, page, geometry }, object)
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
