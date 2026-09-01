import type {
  EditObject, ImagePatchObject, ImagePlacement, LineRun, PageImageIndex, PageQuadIndex,
  TextPatchObject,
} from '@margin/pdf-core'
import { measureText } from '@/lib/fonts'
import { lineBox, patchOnLine } from './linePatch'

/**
 * Where the things the DOCUMENT already contains are drawn, and what is
 * under a given point.
 *
 * Two tools point at these -- `PatchEditor` at lines, `ImageEditor` at
 * images -- and now a double-click under the select tool points at both,
 * without either tool being mounted. That third caller is why this is a
 * module rather than two private functions: a hit test that disagreed with
 * the targets by even a few points would open the editor on a DIFFERENT
 * line from the one the user double-clicked, and there would be nothing on
 * screen to explain why.
 *
 * The rule the whole file follows: a thing is hit where the user can SEE
 * it. What the page originally drew and what is on screen now are the same
 * box until somebody drags or resizes it, and after that only the second
 * one is worth pointing at.
 */

export type Rect = { x: number; y: number; w: number; h: number }

/**
 * How wide a string is, in page units.
 *
 * Injectable only so it can be supplied in tests: measuring goes through a
 * canvas, and jsdom has none, so the real function answers 0 there and a
 * test about overflow would pass for the wrong reason.
 */
export type Measure = (
  text: string,
  family: string,
  size: number,
  style: { bold?: boolean; italic?: boolean },
) => number

/**
 * How wide a line's target has to be.
 *
 * The extraction's own width describes the ORIGINAL line, so once a patch
 * ran past it the tail of the user's own text was not clickable -- the one
 * part of the line they had just written could not be edited again.
 *
 * 'shrink' and 'truncate' both keep the text inside the original line, so
 * only 'overflow' can make the target wider than the extraction says.
 */
function drawnWidth(box: Rect, patch: TextPatchObject | undefined, measure: Measure): number {
  if (!patch || patch.text === '' || patch.fit !== 'overflow') return box.w
  const size = patch.fontSize > 0 ? patch.fontSize : box.h * 0.8
  return Math.max(box.w, measure(patch.text, patch.fontFamily, size, patch))
}

/** Where a line is drawn: its box in the source, plus any drag, plus any overflow. */
export function lineTargetRect(
  line: LineRun,
  patch: TextPatchObject | undefined,
  measure: Measure = measureText,
): Rect {
  const box = lineBox(line)
  const { dx = 0, dy = 0 } = patch?.offset ?? {}
  return {
    x: box.x + dx,
    y: box.y + dy,
    w: drawnWidth(box, patch, measure),
    h: box.h,
  }
}

function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
}

/**
 * The line drawn under a point, or nothing.
 *
 * STRICT containment, unlike `charAt` in `useTextSelection`, which answers
 * with the nearest character however far away it is. That is right for
 * dragging a selection -- a pointer in the gap between two glyphs has to
 * resolve to one of them -- and wrong here: a double-click on a margin
 * would open an editor on whichever line happened to be closest, halfway
 * up the page.
 *
 * The SMALLEST hit wins, so a short line over a long one is reachable.
 */
export function lineAtPoint(
  index: PageQuadIndex,
  objects: readonly EditObject[],
  pageId: string,
  x: number,
  y: number,
  measure: Measure = measureText,
): number | undefined {
  let best: number | undefined
  let bestArea = Infinity

  index.lines.forEach((line, i) => {
    // A line the extraction found no characters on has no box to speak of
    // -- `lineBox` would answer with infinities -- and `PatchEditor` hides
    // its target for the same reason.
    if (line.chars.length === 0) return
    const rect = lineTargetRect(line, patchOnLine(objects, pageId, i), measure)
    if (!contains(rect, x, y)) return
    const area = rect.w * rect.h
    if (area < bestArea) {
      bestArea = area
      best = i
    }
  })

  return best
}

/**
 * The patch covering an image, if the user has already touched it.
 *
 * The sibling of `patchOnLine`, and load-bearing for the same reason: a
 * patch covers and redraws its image, so two on one placement would each
 * cover the other.
 */
export function imagePatchOn(
  objects: Iterable<EditObject>,
  pageId: string,
  imageIndex: number,
): ImagePatchObject | undefined {
  for (const o of objects) {
    if (o.kind === 'imagePatch' && o.pageId === pageId && o.imageIndex === imageIndex) return o
  }
  return undefined
}

/**
 * Where an image is drawn: its box in the source page, plus whatever the
 * user has dragged or resized it by.
 *
 * The COVER does not move, and neither does the placement -- the
 * document's own image is still where it always was, underneath. This is
 * the copy's position, which is the only one anybody can see.
 */
export function imageTargetRect(
  place: ImagePlacement,
  patch: ImagePatchObject | undefined,
): Rect {
  const { dx = 0, dy = 0 } = patch?.offset ?? {}
  return {
    x: place.bbox[0] + dx,
    y: place.bbox[1] + dy,
    w: patch?.size?.w ?? place.bbox[2] - place.bbox[0],
    h: patch?.size?.h ?? place.bbox[3] - place.bbox[1],
  }
}

/**
 * The image drawn under a point, or nothing.
 *
 * The smallest hit wins, which matters more here than it does for lines: a
 * page-filling background photograph with a logo on top is an ordinary
 * layout, and the logo is the one being pointed at.
 */
export function imageAtPoint(
  index: PageImageIndex,
  objects: readonly EditObject[],
  pageId: string,
  x: number,
  y: number,
): number | undefined {
  let best: number | undefined
  let bestArea = Infinity

  for (const place of index.images) {
    const rect = imageTargetRect(place, imagePatchOn(objects, pageId, place.index))
    if (!contains(rect, x, y)) continue
    const area = rect.w * rect.h
    if (area < bestArea) {
      bestArea = area
      best = place.index
    }
  }

  return best
}
