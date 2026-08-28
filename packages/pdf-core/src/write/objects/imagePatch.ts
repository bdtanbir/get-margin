import type { ObjectWriter } from '../index.js'
import type { ImagePatchObject } from '../types.js'
import { coverAndRedraw } from './coverArea.js'
import { pageImages } from '../../images/index.js'
import { PatchRefused } from './patch.js'

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
 *
 * The drawing itself is `coverAndRedraw`, shared with `regionPatch`: the
 * two kinds differ in how they find their rectangle and not at all in what
 * they do with it.
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

  // The placement, not the stored rect: the guard above has just confirmed
  // they describe the same image, and the placement is the one re-derived
  // from the page being written.
  // The object itself is a `CoveredArea`: passing it through rather than
  // rebuilding one keeps the optional fields optional, which is what
  // `exactOptionalPropertyTypes` asks for.
  coverAndRedraw(ctx, o, place.bbox)
}
