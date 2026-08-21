import { pdfRectToView, pageRectToView, type PageGeometry, type ViewRect } from '@margin/transform'
import type { EditObject } from '@margin/pdf-core'

/**
 * Where an object sits on screen, whichever space its rect is stored in.
 *
 * Almost every object's `rect` is raw bottom-up PDF space, which is the
 * documented rule -- markup and redaction go out of their way to honour it,
 * converting their page-space quads when the object is created.
 *
 * `textPatch` is the one exception and cannot stop being one: its rect is
 * the replaced line's own box, taken from the extraction's character quads,
 * so it arrives in MuPDF PAGE space (top-down) and its renderer draws it
 * there, outside the overlay's y-flipped root. Nothing can flip it at rest
 * either -- the writer re-derives its geometry from the page rather than
 * reading the rect, and migrate.ts has no page geometry to flip stored
 * documents with.
 *
 * So the exception lives HERE, in one function, and every surface that asks
 * "where is this object on screen" -- the layers list, the selection box,
 * the floating toolbar -- goes through it rather than each learning the
 * rule separately. Reading a patch's rect as PDF space put it at the mirror
 * image of the line it replaces.
 */
export function objectViewRect(o: EditObject, g: PageGeometry, zoom: number): ViewRect {
  return o.kind === 'textPatch'
    ? pageRectToView(o.rect, g, zoom)
    : pdfRectToView(o.rect, g, zoom)
}
