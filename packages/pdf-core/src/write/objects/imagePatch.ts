import * as mupdf from 'mupdf'
import type { ObjectWriter } from '../index.js'
import type { ImagePatchObject } from '../types.js'
import { appendContent, addResource, fillColor } from '../content.js'
import { num } from '../coords.js'
import { pageImages } from '../../images/index.js'
import { PatchRefused } from './patch.js'

/**
 * How far the cover extends past the image's own box, in points.
 *
 * Small and constant, unlike the text patch's proportional bleed. A glyph
 * quad sits tight against ink that fades out through antialiasing, so a
 * cover has to reach for it; an image has a hard edge at a known place,
 * and the only thing to swallow is the render's own edge antialiasing.
 * Bleeding further would eat whatever sits alongside it -- on a ticket
 * that is usually a rule or a table border a millimetre away.
 */
const BLEED_PT = 0.75

/**
 * Cover, and optionally redraw, one of the document's own images.
 *
 * THE SHAPE IS `writeTextPatch`'S, on purpose. Re-walk the assembled page,
 * check the thing being patched is still the thing that was edited, cover
 * it in the sampled background, then draw the replacement -- if there is
 * one. `data` absent is a deletion, and deletion is the cover alone.
 *
 * THE HASH GUARD IS THE POINT. An `imageIndex` is a position in draw
 * order, and draw order is not stable across a document edited elsewhere.
 * If the image at that index no longer hashes the same, the image there is
 * not the image the user was looking at, so this REFUSES rather than
 * covering whatever happens to be there now -- `PLAN.md` 2.4.
 */
export const writeImagePatch: ObjectWriter = (ctx, object) => {
  const o = object as ImagePatchObject

  // Re-walk the page as it is NOW, in the assembled export.
  const images = pageImages(ctx.page)
  const place = images[o.imageIndex]
  if (!place) {
    throw new PatchRefused(
      `the image this edit refers to is no longer on the page ` +
      `(image ${o.imageIndex + 1} of ${images.length})`,
    )
  }
  if (place.hash !== o.originalHash) {
    throw new PatchRefused(
      `image ${o.imageIndex + 1} has changed since it was edited, so the edit was not ` +
      `applied. It was ${o.rect.w.toFixed(1)}x${o.rect.h.toFixed(1)}pt and is now ` +
      `${(place.bbox[2] - place.bbox[0]).toFixed(1)}x${(place.bbox[3] - place.bbox[1]).toFixed(1)}pt.`,
    )
  }

  // The placement is MuPDF page space (top-down); content-stream drawing is
  // raw user space (bottom-up). Same flip `writeTextPatch` does, and for
  // the same reason: the geometry came from extraction, not from a stored
  // rect that `toContentSpace` could convert.
  const [cx0, cy0, cx1, cy1] = ctx.geometry.cropBox
  const pageHeight = Math.abs(cy1 - cy0)
  const [bx0, by0, bx1, by1] = place.bbox
  const x = bx0 + cx0
  const y = pageHeight - by1 + cy0
  const w = bx1 - bx0
  const h = by1 - by0

  const ops: string[] = [
    fillColor(o.background),
    `${num(x - BLEED_PT)} ${num(y - BLEED_PT)} ${num(w + BLEED_PT * 2)} ${num(h + BLEED_PT * 2)} re`,
    'f',
  ]

  if (o.data && o.data.length > 0) {
    /**
     * Page space is top-down and the content stream is bottom-up, so `dy`
     * SUBTRACTS from y. Getting that flip wrong moves the image exactly as
     * far the wrong way, which reads as deliberate rather than as a bug --
     * so the direction is pinned by a test, as the text patch's is.
     */
    const dx = o.offset?.dx ?? 0
    const dy = o.offset?.dy ?? 0

    const data = o.data
    // Memoised on the bytes by the same cache every image placement uses,
    // so moving one logo on ten pages embeds one copy.
    const { name, obj } = ctx.xobject(data, () => ctx.raw.addImage(new mupdf.Image(data)))
    addResource(ctx.raw, ctx.page, 'XObject', name, obj)

    // An image XObject's own space is the unit square with its origin at
    // the bottom-left, so the CTM carries both position and size.
    // No q/Q around this: `appendContent` already brackets every fragment
    // it appends, and the `cm` is the last thing this one emits. The same
    // reason `writeImage` does not bracket its own placement either.
    ops.push(
      `${num(w)} 0 0 ${num(h)} ${num(x + dx)} ${num(y - dy)} cm`,
      `/${name} Do`,
    )
  }

  appendContent(ctx.raw, ctx.page, ops.join('\n'))
}
