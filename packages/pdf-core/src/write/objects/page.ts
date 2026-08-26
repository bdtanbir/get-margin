import type * as mupdf from 'mupdf'
import type { PageGeometry } from '@margin/transform'
import type { EditDocument } from '../types.js'
import { toAnnotSpace, toContentSpace, num } from '../coords.js'
import { appendContent, fillColor, blendState } from '../content.js'

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

/**
 * Tint each page in its background colour.
 *
 * MULTIPLY OVER THE CONTENT, not an opaque fill under it, and that choice
 * is the whole feature working or not working.
 *
 * Under the content is the obvious implementation and it is wrong for most
 * real files. A page is usually white because NOTHING painted it -- and an
 * underlying fill is exactly right for those -- but any page printed from a
 * browser paints its own opaque white background across the sheet, and a
 * fill beneath that is invisible. Measured on a real HTML-to-PDF ticket:
 * every one of its 500,990 pixels came back opaque.
 *
 * `Multiply` computes `backdrop x source`, so it covers both cases with one
 * rule: white paper (painted or unpainted, both composite as white) takes
 * the colour exactly, black text stays black, and nothing on the page can
 * be hidden by it. That last part is why this is safe to apply to a
 * document sight unseen -- there is no colour the user can pick that
 * erases their content.
 *
 * BEFORE the object writers, so the user's own text and shapes are drawn ON
 * the tinted page rather than through the tint. A stamp asking to sit
 * `behind` the content prepends, so it lands under this and is tinted with
 * the page -- which is what "behind the content" asked for.
 *
 * The rect is the page's CropBox as it stands NOW, read through `geometryOf`
 * rather than from the source: `applyPageBoxes` has already run, so a page
 * the user cropped is filled to the crop the user drew and not to the box it
 * had when the file was opened. Convention B -- a content stream speaks raw
 * PDF user space, CropBox origin NOT normalised -- so the offset corner of a
 * non-zero-origin page is part of the rect, not something to subtract.
 */
export function applyPageBackgrounds(
  raw: mupdf.PDFDocument,
  editDoc: EditDocument,
  geometryOf: (index: number) => PageGeometry,
): void {
  editDoc.pageOrder.forEach((pageId, index) => {
    const background = editDoc.pages[pageId]?.background
    if (!background) return

    const [x0, y0, x1, y1] = geometryOf(index).cropBox
    const { x, y, w, h } = toContentSpace({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })

    const page = raw.loadPage(index)
    try {
      appendContent(raw, page, [
        blendState(raw, page, `GSbg${index}`, 'Multiply'),
        fillColor(background),
        `${num(x)} ${num(y)} ${num(w)} ${num(h)} re f`,
      ].join('\n'))
    } finally {
      page.destroy()
    }
  })
}
