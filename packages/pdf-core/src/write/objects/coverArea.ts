import * as mupdf from 'mupdf'
import type { WriteContext } from '../index.js'
import type { Color } from '../types.js'
import { appendContent, addResource, fillColor } from '../content.js'
import { num, pageBoxToContent, pagePointToContent, pageDeltaToContent } from '../coords.js'

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
 * `box` is MuPDF PAGE space (Convention C): [x0, y0, x1, y1], top-down and
 * with /Rotate applied. Both callers get their geometry from extraction or
 * from a page-space rect rather than from a stored PDF-space rect, which is
 * why the conversion happens here rather than through `toContentSpace`.
 *
 * `offset` and `size` are page-space too, so the arithmetic that positions
 * the copy is all done in page space and converted once at the end. That
 * ordering is what makes a turned page work: page space is the space the
 * user was looking at when they dragged the copy, and it is the only one in
 * which "down" means down.
 */
export function coverAndRedraw(
  ctx: WriteContext,
  area: CoveredArea,
  box: [number, number, number, number],
): void {
  const g = ctx.geometry
  const [bx0, by0, bx1, by1] = box
  /**
   * The cover, in content space.
   *
   * This used to be a y-flip against the UNROTATED CropBox height with x
   * passed through -- which is the same thing on a /Rotate 0 page and wrong
   * on every turned one, where page space has the swapped axes and a cover
   * computed that way lands off the page.
   */
  const cover = pageBoxToContent(box, g)
  // Page-space extents. A quarter-turn swaps `cover.w`/`cover.h` against
  // these, so the copy's own sizing below stays on the page-space pair.
  const pw = Math.abs(bx1 - bx0)
  const ph = Math.abs(by1 - by0)

  const ops: string[] = [
    fillColor(area.background),
    `${num(cover.x - BLEED_PT)} ${num(cover.y - BLEED_PT)} ` +
      `${num(cover.w + BLEED_PT * 2)} ${num(cover.h + BLEED_PT * 2)} re`,
    'f',
  ]

  const data = area.data
  if (data && data.length > 0) {
    /**
     * `offset` is a page-space displacement, and page space is top-down, so
     * a positive `dy` moves the copy DOWN the page as the user saw it.
     * Adding it here, before the conversion, is what keeps that true on a
     * turned page -- the direction is pinned by a test for each kind that
     * uses this, because getting it wrong moves the copy exactly as far the
     * wrong way and so reads as deliberate rather than as a bug.
     */
    const dx = area.offset?.dx ?? 0
    const dy = area.offset?.dy ?? 0

    /**
     * The copy's own size, defaulting to the area's -- which is what every
     * patch written before `size` existed meant, so no stored document
     * needs migrating and the schema version did not have to move.
     */
    const drawW = area.size?.w ?? pw
    const drawH = area.size?.h ?? ph

    /**
     * An image XObject's unit square has its origin at the BOTTOM-left,
     * while `offset` positions the copy's TOP-left, so the anchor is the
     * page-space corner one drawn height further down the page.
     */
    const anchor = pagePointToContent({ x: bx0 + dx, y: by0 + dy + drawH }, g)

    /**
     * The copy carries the page's turn in its own matrix.
     *
     * The bytes are a picture of what the page LOOKED like, so the CTM has
     * to map the image's own axes -- right, and up -- onto whatever
     * directions those are in raw user space. On an unrotated page that is
     * the plain `w 0 0 h` scale this replaced; on a /Rotate 90 page an
     * axis-aligned CTM would draw the copy at a right angle to the original
     * it is standing in for.
     */
    const right = pageDeltaToContent({ x: 1, y: 0 }, g)
    const up = pageDeltaToContent({ x: 0, y: -1 }, g)

    // Memoised on the bytes by the same cache every image placement uses,
    // so one lifted logo repeated on ten pages embeds once.
    const { name, obj } = ctx.xobject(data, () => ctx.raw.addImage(new mupdf.Image(data)))
    addResource(ctx.raw, ctx.page, 'XObject', name, obj)

    // An image XObject's own space is the unit square with its origin at
    // the bottom-left, so the CTM carries both position and size. No q/Q:
    // `appendContent` brackets every fragment it appends, and this `cm` is
    // the last thing this one emits.
    ops.push(
      `${num(drawW * right.x)} ${num(drawW * right.y)} ` +
        `${num(drawH * up.x)} ${num(drawH * up.y)} ` +
        `${num(anchor.x)} ${num(anchor.y)} cm`,
      `/${name} Do`,
    )
  }

  appendContent(ctx.raw, ctx.page, ops.join('\n'))
}
