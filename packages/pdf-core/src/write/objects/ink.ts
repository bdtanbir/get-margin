import type { ObjectWriter } from '../index.js'
import type { InkObject } from '../types.js'
import { pdfToView } from '@margin/transform'

/**
 * Freehand ink as a NATIVE Ink annotation (the semantic split in spec 0):
 * ink is an annotation, so it stays selectable and removable in Acrobat and
 * Preview instead of being burned into the page content. Phase 0 confirmed
 * Ink renders from an auto-generated /AP, pixel-identical between MuPDF and
 * Apple CoreGraphics.
 *
 * CONVENTION A applies here, not B: setInkList/setRect are annotation
 * setters, so points go in page space at scale 1 with no manual flip.
 * Passing raw bottom-up PDF points would mirror every stroke vertically --
 * and on an unrotated letter page it would still look like a plausible
 * squiggle, which is exactly why this is pinned by a test.
 *
 * setInkList takes Point[][] where Point is [x, y] (mupdf.d.ts:780) -- a
 * list of strokes, each a list of PAIRS. `strokes` stores each stroke flat
 * as [x0,y0,x1,y1,...] because a flat array of numbers is what survives
 * structured-clone across the worker boundary cheaply, so this is where the
 * two shapes meet.
 *
 * NO setRect. MuPDF throws "Ink annotations have no Rect property" -- it
 * derives the bounding box from the ink list itself when update() runs. The
 * object's own `rect` therefore describes the stroke for SELECTION purposes
 * only and is never written; the exported annotation's box comes from the
 * points. That also means the two cannot disagree.
 */
export const writeInk: ObjectWriter = (ctx, object) => {
  const o = object as InkObject
  const annot = ctx.page.createAnnotation('Ink')
  annot.setColor([...o.color])
  annot.setBorderWidth(o.strokeWidth)
  annot.setOpacity(o.opacity)
  annot.setInkList(
    o.strokes.map((flat) => {
      const points: [number, number][] = []
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const v = pdfToView({ x: flat[i]!, y: flat[i + 1]! }, ctx.geometry, 1)
        points.push([v.x, v.y])
      }
      return points
    }),
  )
  // Without update() the annotation has no /AP, and a viewer that does not
  // synthesise one shows nothing at all.
  annot.update()
}
