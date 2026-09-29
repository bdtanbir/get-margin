import { PdfDocument } from '../engine.js'
import { cropRegion } from '../images/index.js'
import { replay } from './index.js'
import type { SourceBytes, SourcePasswords } from './assemble.js'
import type { FontProvider } from './fonts.js'
import type { EditDocument, PageId } from './types.js'

/**
 * Any rectangle of a page AS EDITED, as pixels.
 *
 * `cropRegion` renders the source page, and the source page is not what
 * the user is looking at. Every edit lives only in the edit document until
 * export, and on screen it is drawn over the page as an overlay -- so a
 * lift taken from the source carries a picture of the page as the
 * document ORIGINALLY said it. Change a total from $248 to 25,000 BDT,
 * lift the total box to move it up, and $248 comes along.
 *
 * So the page is written first. The edit document is cut down to the one
 * page being lifted and handed to `replay`, the same path Download takes,
 * which is what guarantees the lifted pixels match the exported file
 * rather than approximating it. One page rather than the whole document,
 * because a lift is a gesture and a twelve-page export is not.
 *
 * `rect` is MuPDF page space of the page AS THE USER SEES IT: the source
 * page's own rotation with the edit store's rotation folded in, which is
 * the space the overlay's viewBox describes. `replay` applies that
 * rotation before drawing, so page 0 of what it writes is in exactly that
 * space -- which the source page, on a page turned in the app, is not.
 */
export function cropEditedRegion(
  sources: SourceBytes,
  editDoc: EditDocument,
  pageId: PageId,
  rect: { x: number; y: number; w: number; h: number },
  scale: number,
  opts: { fonts?: FontProvider; passwords?: SourcePasswords } = {},
): { data: Uint8Array } | undefined {
  const entry = editDoc.pages[pageId]
  if (!entry) return undefined

  const objects = Object.values(editDoc.objects).filter((o) => o.pageId === pageId)
  const onePage: EditDocument = {
    ...editDoc,
    pageOrder: [pageId],
    pages: { [pageId]: entry },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
  }

  // With nothing to draw and a one-page source, replay hands the original
  // bytes back -- and page 0 of those IS the page, so the crop is right
  // either way.
  const bytes = replay(sources, onePage, {
    ...(opts.fonts ? { fonts: opts.fonts } : {}),
    ...(opts.passwords ? { passwords: opts.passwords } : {}),
  })
  const doc = PdfDocument.open(bytes)
  try {
    return cropRegion(doc, 0, rect, scale)
  } finally {
    doc.close()
  }
}
