import * as mupdf from 'mupdf'
import type { WriteContext } from '../index.js'
import type { Color } from '../types.js'
import { appendContent, addResource, fillColor } from '../content.js'
import { num } from '../coords.js'

/**
 * How far a cover extends past the area it hides, in points.
 *
 * Small and constant, unlike the text patch's proportional bleed. A glyph
 * quad sits tight against ink that fades out through antialiasing, so a
 * cover has to reach for it; an image or a drawn region has a hard edge at
 * a known place, and the only thing to swallow is the render's own edge
 * antialiasing. Bleeding further would eat whatever sits alongside -- on a
 * ticket that is usually a rule or a table border a millimetre away.
 */
export const BLEED_PT = 0.75

/** Everything the drawing needs that is not geometry. */
export type CoveredArea = {
  id: string
  /** The colour to paint over the original, sampled at edit time. */
  background: Color
  /** The copy to redraw. Absent means the area is simply hidden. */
  data?: Uint8Array
  mime?: 'image/png'
  /** How far the copy sits from the area, in points, page space. */
  offset?: { dx: number; dy: number }
  /** The size the copy is drawn at. Absent means the size of the area. */
  size?: { w: number; h: number }
}

/**
 * Cover a rectangle of the page, and optionally redraw a copy of it
 * somewhere else.
 *
 * The half that `imagePatch` and `regionPatch` share. They differ only in
 * how they FIND their rectangle -- one re-walks the page's images and
 * checks a hash, the other simply carries the rectangle the user drew --
 * and not at all in what they then draw, so the drawing lives here rather
 * than in two copies that could drift by a bleed or a sign.
 *
 * `box` is MuPDF PAGE space (top-down): [x0, y0, x1, y1]. Both callers get
 * their geometry from extraction or from a page-space rect rather than
 * from a stored PDF-space rect, which is why the flip happens here against
 * the page's own height instead of through `toContentSpace`.
 */
export function coverAndRedraw(
  ctx: WriteContext,
  area: CoveredArea,
  box: [number, number, number, number],
): void {
  const [cx0, cy0, cx1, cy1] = ctx.geometry.cropBox
  const pageHeight = Math.abs(cy1 - cy0)
  const [bx0, by0, bx1, by1] = box
  const x = bx0 + cx0
  const y = pageHeight - by1 + cy0
  const w = bx1 - bx0
  const h = by1 - by0

  const ops: string[] = [
    fillColor(area.background),
    `${num(x - BLEED_PT)} ${num(y - BLEED_PT)} ${num(w + BLEED_PT * 2)} ${num(h + BLEED_PT * 2)} re`,
    'f',
  ]

  const data = area.data
  if (data && data.length > 0) {
    /**
     * Page space is top-down and the content stream is bottom-up, so `dy`
     * SUBTRACTS from y. Getting that flip wrong moves the copy exactly as
     * far the wrong way, which reads as deliberate rather than as a bug --
     * so the direction is pinned by a test for each kind that uses this.
     */
    const dx = area.offset?.dx ?? 0
    const dy = area.offset?.dy ?? 0

    /**
     * The copy's own size, defaulting to the area's -- which is what every
     * patch written before `size` existed meant, so no stored document
     * needs migrating and the schema version did not have to move.
     */
    const drawW = area.size?.w ?? w
    const drawH = area.size?.h ?? h

    /**
     * `offset` positions the copy's TOP-LEFT corner, and a content stream
     * places an image by its BOTTOM-left, so the drawn height comes off
     * the y. With no resize this reduces to `y - dy`, which is what it
     * always was.
     */
    const drawY = y + h - drawH - dy

    // Memoised on the bytes by the same cache every image placement uses,
    // so one lifted logo repeated on ten pages embeds once.
    const { name, obj } = ctx.xobject(data, () => ctx.raw.addImage(new mupdf.Image(data)))
    addResource(ctx.raw, ctx.page, 'XObject', name, obj)

    // An image XObject's own space is the unit square with its origin at
    // the bottom-left, so the CTM carries both position and size. No q/Q:
    // `appendContent` brackets every fragment it appends, and this `cm` is
    // the last thing this one emits.
    ops.push(
      `${num(drawW)} 0 0 ${num(drawH)} ${num(x + dx)} ${num(drawY)} cm`,
      `/${name} Do`,
    )
  }

  appendContent(ctx.raw, ctx.page, ops.join('\n'))
}
