import { viewRectToPdf, type PageGeometry } from '@margin/transform'
import type { EditObject, Op } from '@margin/pdf-core'
import { objectViewRect } from './objectViewRect'

/**
 * Move an object by a step the user asked for in POINTS -- what the arrow
 * keys do.
 *
 * The same journey `SelectionChrome`'s drag makes, with one difference that
 * decides the shape of this module: a drag is measured in CSS pixels, so at
 * 400% zoom a 4px flick is a point of paper, while a nudge is measured in
 * the DOCUMENT. A keyboard step that shrank as you zoomed in would be the
 * opposite of what the keyboard is for -- it is the tool you reach for when
 * the mouse is not precise enough.
 *
 * What it cannot do differently is WHICH GEOMETRY it writes, and that is
 * per-kind rather than universal:
 *
 * A patch -- an edited line, a lifted image, a lifted area -- accumulates
 * an `offset` and leaves its `rect` alone. The rect is the area being
 * COVERED and has to stay over the document's own content; moving it slides
 * the cover off the glyphs it hides, and they reappear from underneath the
 * replacement. Its space is MuPDF page space, which runs top-down like the
 * screen, so a step up the screen is a smaller dy.
 *
 * Everything else moves its `rect`, which is raw PDF space: bottom-up, with
 * the CropBox origin and /Rotate still to be applied. So the move is
 * expressed where the user made it -- on screen -- and converted back
 * through `@margin/transform`, which is what makes a nudge on a
 * quarter-turned page go the way the arrow points rather than the way the
 * stored axis happens to run. This module performs no coordinate arithmetic
 * of its own beyond the addition (spec 1.4's standing rule).
 */
export function nudgeOpFor(
  o: EditObject,
  step: { dx: number; dy: number },
  g: PageGeometry,
  zoom: number,
): Op | undefined {
  // Locked means locked against the keyboard too. The same rule the drag
  // follows, and the same one Delete follows.
  if (o.locked) return undefined

  if (o.kind === 'textPatch' || o.kind === 'imagePatch' || o.kind === 'regionPatch') {
    const { dx = 0, dy = 0 } = o.offset ?? {}
    return {
      type: 'updateObject',
      id: o.id,
      patch: { offset: { dx: dx + step.dx, dy: dy + step.dy } },
    }
  }

  // Where it is on screen, moved by the step scaled to screen -- then back.
  // Going out and back through the same conversion the selection box uses
  // is what keeps the object exactly where the box said it was.
  const view = objectViewRect(o, g, zoom)
  const rect = viewRectToPdf(
    { ...view, x: view.x + step.dx * zoom, y: view.y + step.dy * zoom },
    g,
    zoom,
  )
  return { type: 'updateObject', id: o.id, patch: { rect } }
}
