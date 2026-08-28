import type { ObjectWriter } from '../index.js'
import type { RegionPatchObject } from '../types.js'
import { coverAndRedraw } from './coverArea.js'

/**
 * Cover, and optionally redraw, an area of the page the USER drew a box
 * around.
 *
 * The escape hatch from `imagePatch`, and it exists because a great deal
 * of what a reader calls "the logo" is not an image. Page 2 of a real
 * US-Bangla e-ticket draws the same logo page 1 embeds as a 1200x286
 * raster using 21 vector paths instead: no image walk can reach it, and no
 * clustering heuristic can decide where it ends without sometimes taking
 * the rule beside it. Letting the user draw the boundary settles both.
 *
 * NO HASH GUARD, which is a real difference from `imagePatch` rather than
 * an omission. An image patch is addressed by POSITION IN A WALK, and a
 * position means nothing without a check that what sits there is still
 * what was edited -- so it refuses on a changed page. A region is
 * addressed by its own geometry: it describes the rectangle it covers, and
 * that rectangle means the same thing whatever else has changed. There is
 * nothing here that could be mistaken for something else, so there is
 * nothing to refuse.
 */
export const writeRegionPatch: ObjectWriter = (ctx, object) => {
  const o = object as RegionPatchObject
  coverAndRedraw(ctx, o, [o.rect.x, o.rect.y, o.rect.x + o.rect.w, o.rect.y + o.rect.h])
}
