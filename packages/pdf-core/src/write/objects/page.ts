import type * as mupdf from 'mupdf'
import type { PageGeometry } from '@margin/transform'
import type { EditDocument } from '../types.js'
import { toAnnotSpace } from '../coords.js'

/**
 * Apply each page's rotation and crop, AFTER assembly and BEFORE objects
 * are drawn.
 *
 * CROP IS CONVENTION A. setPageBox speaks top-down MuPDF page space, like
 * setRect and setQuadPoints: passing [100,100,400,500] on a 792pt-tall page
 * writes [100,292,400,692] to disk (measured,
 * docs/findings/07-phase-3-preflight.md). A raw bottom-up rect is accepted
 * silently and mirrors the crop vertically, which on a near-symmetric crop
 * looks entirely plausible. Hence toAnnotSpace, and hence a pinning test.
 *
 * Rotation is NOT Convention A: /Rotate is a plain integer on the page
 * dict, ADDED to whatever the source page already had rather than
 * replacing it.
 */
export function applyPageBoxes(
  raw: mupdf.PDFDocument,
  editDoc: EditDocument,
  geometryOf: (index: number) => PageGeometry,
): void {
  editDoc.pageOrder.forEach((pageId, index) => {
    const entry = editDoc.pages[pageId]
    if (!entry) return
    if (entry.rotation === 0 && entry.cropBox === null) return

    const page = raw.loadPage(index)
    try {
      if (entry.cropBox) {
        const [x0, y0, x1, y1] = entry.cropBox
        const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
        page.setPageBox('CropBox', toAnnotSpace(rect, geometryOf(index)))
      }
      if (entry.rotation !== 0) {
        const obj = page.getObject()
        const current = obj.get('Rotate').isNumber() ? obj.get('Rotate').asNumber() : 0
        obj.put('Rotate', (((current + entry.rotation) % 360) + 360) % 360)
      }
    } finally {
      page.destroy()
    }
  })
}
