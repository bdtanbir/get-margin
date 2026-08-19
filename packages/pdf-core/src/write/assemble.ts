import * as mupdf from 'mupdf'
import type { EditDocument, SourceId } from './types.js'

export type SourceBytes = Map<SourceId, Uint8Array>

/**
 * True when the edit describes exactly the file that was opened: one
 * source, EVERY page in its original position, nothing rotated or cropped.
 *
 * `sourcePageCount` is not optional and not decoration. Without it, an
 * extract of the first three pages of a twelve-page document looks
 * untouched -- pages 0,1,2 do sit at positions 0,1,2 -- and the export
 * silently hands back all twelve.
 *
 * The caller uses this to return the user's original bytes untouched.
 * `e2e/download.spec.ts` asserts that byte-for-byte identity, and it is a
 * real promise: an unedited Download should return the file you opened, not
 * a re-serialisation of it with a different size.
 */
export function isUntouched(editDoc: EditDocument, sourcePageCount: number): boolean {
  if (Object.keys(editDoc.sources).length !== 1) return false
  if (editDoc.pageOrder.length !== sourcePageCount) return false
  if (editDoc.pageOrder.length !== Object.keys(editDoc.pages).length) return false
  return editDoc.pageOrder.every((pageId, i) => {
    const page = editDoc.pages[pageId]
    return !!page && page.sourceIndex === i && page.rotation === 0 && page.cropBox === null
  })
}

/**
 * Passwords for sources that need one, by source id.
 *
 * Held only for the life of a call. A password is a secret and nothing
 * here writes it anywhere; it exists so the writer can DECRYPT a document
 * the user has already unlocked.
 */
export type SourcePasswords = Map<SourceId, string>

function open(
  sources: SourceBytes,
  id: SourceId,
  passwords?: SourcePasswords,
): mupdf.PDFDocument {
  const bytes = sources.get(id)
  if (!bytes) throw new Error(`source "${id}" was not supplied to the export.`)
  const raw = mupdf.PDFDocument.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument

  /**
   * AUTHENTICATE, or the export is blank.
   *
   * An encrypted document opens without a password -- its structure is
   * readable -- but every content stream stays undecryptable, so writing
   * it back out produces a file with pages and no content. Not an error,
   * not a warning: a silently empty document that opens fine and says
   * nothing. It affected any edit to a password-protected file and was
   * found by testing "open a protected PDF, edit it, export".
   */
  if (raw.needsPassword()) {
    const password = passwords?.get(id)
    if (password === undefined || !raw.authenticatePassword(password)) {
      raw.destroy()
      throw new Error(
        `"${id}" is password-protected and the password was not available to the export. ` +
        `Reopen the document and enter it again.`,
      )
    }
  }

  return raw
}

/**
 * graftPage copies page CONTENT and nothing else: the target page's
 * /Annots comes back null, so every highlight, ink stroke, link, and form
 * field already in the source is destroyed (measured,
 * docs/findings/07-phase-3-preflight.md). Grafting the /Annots array
 * explicitly restores them, appearance streams included.
 *
 * Phase 2's own objects are unaffected either way, because they are drawn
 * from EditDocument AFTER assembly -- which is exactly what makes this easy
 * to miss when testing with freshly generated fixtures. The regression test
 * for it uses a source that already carries annotations.
 */
function graftWithAnnots(
  target: mupdf.PDFDocument,
  map: mupdf.PDFGraftMap,
  src: mupdf.PDFDocument,
  srcIndex: number,
  targetIndex: number,
): void {
  target.graftPage(-1, src, srcIndex)
  const srcPage = src.loadPage(srcIndex)
  try {
    const annots = srcPage.getObject().get('Annots')
    if (annots.isArray()) target.findPage(targetIndex).put('Annots', map.graftObject(annots))
  } finally {
    srcPage.destroy()
  }
}

/**
 * Build the document the edit describes and hand back the open handle.
 * The caller owns it and must destroy it.
 *
 * TWO STRATEGIES, and the choice is about LOSS, not speed:
 *
 *   Single source -> unlink every page and re-insert the kept ones in the
 *   new order. deletePage removes a page from the page tree but leaves the
 *   object reachable, so handles collected first stay valid. Lossless:
 *   annotations, links, outlines, and metadata all survive.
 *
 *   Several sources -> graft, plus the explicit /Annots graft above. This
 *   is the only way to combine documents, and document-level structure
 *   (outlines, page labels) cannot come across at all -- which the merge UI
 *   states rather than dropping silently.
 */
/**
 * The assembled document, plus whether its page tree was left alone.
 *
 * `unchanged` lets the caller hand back the ORIGINAL bytes rather than a
 * re-serialisation, without opening the source a second time to find out.
 */
export type Assembled = { raw: mupdf.PDFDocument; unchanged: boolean }

/**
 * Build the document the edit describes and hand back the open handle.
 * The caller owns it and must destroy it.
 *
 * TWO STRATEGIES, and the choice is about LOSS, not speed:
 *
 *   Single source -> unlink every page and re-insert the kept ones in the
 *   new order. deletePage removes a page from the page tree but leaves the
 *   object reachable, so handles collected first stay valid. Lossless:
 *   annotations, links, outlines, and metadata all survive.
 *
 *   Several sources -> graft, plus the explicit /Annots graft above. This
 *   is the only way to combine documents, and document-level structure
 *   (outlines, page labels) cannot come across at all -- which the merge UI
 *   states rather than dropping silently.
 */
export function assemble(
  sources: SourceBytes,
  editDoc: EditDocument,
  passwords?: SourcePasswords,
): Assembled {
  const sourceIds = Object.keys(editDoc.sources)

  if (sourceIds.length === 1) {
    const only = sourceIds[0]!
    const raw = open(sources, only, passwords)
    try {
      // Checked with the document open, so the page count is known without
      // parsing the file twice.
      if (isUntouched(editDoc, raw.countPages())) return { raw, unchanged: true }

      // findPage BEFORE deleting anything: these handles must outlive the
      // page-tree surgery below.
      const keep = editDoc.pageOrder.map((pageId) => {
        const page = editDoc.pages[pageId]
        if (!page) throw new Error(`edit document references unknown page "${pageId}"`)
        return raw.findPage(page.sourceIndex)
      })
      for (let i = raw.countPages() - 1; i >= 0; i--) raw.deletePage(i)
      for (const pageObj of keep) raw.insertPage(-1, pageObj)
      return { raw, unchanged: false }
    } catch (e) {
      raw.destroy()
      throw e
    }
  }

  const target = new mupdf.PDFDocument()
  const opened = new Map<SourceId, mupdf.PDFDocument>()
  // ONE GRAFT MAP PER SOURCE. A PDFGraftMap is bound to the document it
  // first grafted from -- reusing one across sources fails with "grafted
  // objects must all belong to the same source document".
  const maps = new Map<SourceId, mupdf.PDFGraftMap>()
  try {
    editDoc.pageOrder.forEach((pageId, targetIndex) => {
      const page = editDoc.pages[pageId]
      if (!page) throw new Error(`edit document references unknown page "${pageId}"`)
      let src = opened.get(page.sourceId)
      if (!src) {
        src = open(sources, page.sourceId, passwords)
        opened.set(page.sourceId, src)
        maps.set(page.sourceId, target.newGraftMap())
      }
      graftWithAnnots(target, maps.get(page.sourceId)!, src, page.sourceIndex, targetIndex)
    })
  } catch (e) {
    target.destroy()
    throw e
  } finally {
    // Each source is opened ONCE and closed together; opening per page
    // would reparse a 300-page document once per grafted page.
    for (const d of opened.values()) d.destroy()
  }
  return { raw: target, unchanged: false }
}
