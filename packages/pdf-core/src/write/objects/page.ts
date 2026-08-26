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

/**
 * Put each page's form fields in the order the user chose, and tell viewers
 * to honour it.
 *
 * Tab order IS /Annots order in the PDF format -- there is no separate
 * ordering structure for it. /Tabs /R on the page dictionary asks the
 * viewer to follow the array in row order rather than substituting its own
 * geometric guess, which several viewers do by default.
 *
 * Non-widget annotations keep their relative positions and stay after the
 * widgets: the array's order means nothing for ink or a highlight, so there
 * is nothing to preserve there and nothing to gain from interleaving.
 *
 * A name in `tabOrder` matching no field on the page is ignored, and a
 * field the order does not mention goes last in its existing order. Both
 * happen from ordinary editing -- delete a field after ordering, or add one
 * after -- and neither is a reason to fail an export.
 */
export function applyTabOrder(
  raw: mupdf.PDFDocument,
  editDoc: EditDocument,
): void {
  editDoc.pageOrder.forEach((pageId, index) => {
    const order = editDoc.pages[pageId]?.tabOrder
    if (!order || order.length === 0) return

    const page = raw.loadPage(index)
    try {
      const obj = page.getObject()
      const annots = obj.get('Annots')
      if (!annots.isArray()) return

      const widgets: Array<{ obj: mupdf.PDFObject; name: string }> = []
      const others: mupdf.PDFObject[] = []
      annots.forEach((a) => {
        if (a.isDictionary() && a.get('Subtype').asName() === 'Widget') {
          // A radio kid's /T lives on its parent, so the name has to be
          // looked for in both places or every button sorts as unnamed.
          const own = a.get('T')
          const parent = a.get('Parent')
          const name = own.isString()
            ? own.asString()
            : parent.isDictionary() && parent.get('T').isString()
              ? parent.get('T').asString()
              : ''
          widgets.push({ obj: a, name })
        } else {
          others.push(a)
        }
      })
      if (widgets.length === 0) return

      const rank = (name: string): number => {
        const at = order.indexOf(name)
        return at === -1 ? Number.MAX_SAFE_INTEGER : at
      }
      // A stable sort, which Array.prototype.sort is required to be, keeps
      // unmentioned fields in the order they were already in.
      const sorted = [...widgets].sort((a, b) => rank(a.name) - rank(b.name))

      const next = raw.newArray()
      for (const w of sorted) next.push(w.obj)
      for (const o of others) next.push(o)
      obj.put('Annots', next)
      obj.put('Tabs', raw.newName('R'))
    } finally {
      page.destroy()
    }
  })
}
