import type { ObjectWriter } from '../index.js'
import type { MarkupObject } from '../types.js'
const SUBTYPE = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'StrikeOut',
} as const

/**
 * Native markup annotations with /QuadPoints -- the semantic-split half of
 * the design (spec 0). Native means they stay editable and removable in
 * Acrobat and do not damage the page. Phase 0 confirmed all three produce
 * real auto-generated /AP streams and render pixel-identically between
 * MuPDF and Apple CoreGraphics.
 *
 * CONVENTION A, with a twist worth stating: `quads` arrive from
 * buildQuadIndex ALREADY in MuPDF page space, which is exactly what
 * setQuadPoints expects, so they must NOT be converted again. Two
 * coordinate spaces inside one object is unusual; it is deliberate, and
 * MarkupObject's type declaration says so too.
 *
 * NO setRect. MuPDF throws "Highlight annotations have no Rect property"
 * (likewise Underline and StrikeOut, and Ink for the same reason) -- it
 * derives the bounding box from the quad points during update(). The
 * object's own `rect` is therefore SELECTION geometry only and is never
 * written, which also means the two cannot disagree.
 */
export const writeMarkup: ObjectWriter = (ctx, object) => {
  const o = object as MarkupObject
  const annot = ctx.page.createAnnotation(SUBTYPE[o.kind])
  annot.setQuadPoints(o.quads.map((q) => [...q] as [
    number, number, number, number, number, number, number, number,
  ]))
  annot.setColor([...o.color])
  annot.setOpacity(o.opacity)
  // update() is what generates the /AP. Without it the annotation exists in
  // the file but renders as nothing in most viewers.
  annot.update()
}
