import { pdfRectToView, pageRectToView, type PageGeometry, type ViewRect } from '@margin/transform'
import type { EditObject } from '@margin/pdf-core'

/**
 * Where an object sits on screen, whichever space its rect is stored in.
 *
 * Almost every object's `rect` is raw bottom-up PDF space, which is the
 * documented rule -- markup and redaction go out of their way to honour it,
 * converting their page-space quads when the object is created.
 *
 * The three patch kinds are the exceptions, and cannot stop being ones. A
 * `textPatch`'s rect is the replaced line's own box, taken from the
 * extraction's character quads; an `imagePatch`'s is where the page draws
 * the image, taken from the device walk. Both therefore arrive in MuPDF
 * PAGE space (top-down) and both renderers draw them there, outside the
 * overlay's y-flipped root. Nothing can flip either at rest -- the writers
 * re-derive their geometry from the page rather than reading the rect, and
 * migrate.ts has no page geometry to flip stored documents with.
 *
 * So the exception lives HERE, in one function, and every surface that asks
 * "where is this object on screen" -- the layers list, the selection box,
 * the floating toolbar -- goes through it rather than each learning the
 * rule separately. Reading a patch's rect as PDF space put it at the mirror
 * image of the line it replaces.
 */
export function objectViewRect(o: EditObject, g: PageGeometry, zoom: number): ViewRect {
  const isPatch = o.kind === 'textPatch' || o.kind === 'imagePatch' || o.kind === 'regionPatch'
  if (!isPatch) return pdfRectToView(o.rect, g, zoom)
  /**
   * A patch's rect is the line it REPLACES, and stays there however far the
   * replacement has been dragged -- the cover is drawn from it, and the
   * cover does not move (write/objects/patch.ts). So the offset is added
   * here rather than folded into the rect at rest: this function answers
   * "where is the thing the user sees", and after a move that is the text,
   * not the cover it left behind.
   *
   * Page space is top-down, so a positive dy adds to y. The writer
   * subtracts the same number for the same movement because a content
   * stream is bottom-up; both signs are pinned by tests.
   */
  const { dx = 0, dy = 0 } = o.offset ?? {}
  /**
   * The COPY'S size, where it has one of its own.
   *
   * An image patch and a lifted area can be resized, and their `size` is
   * deliberately separate from `rect`: the rect is the area being covered
   * and must stay over the page's own content, while the copy is a picture
   * and can be any size it was dragged to. Reading the rect's size here
   * would draw the selection box, the layers row and the floating toolbar
   * around the covered area instead -- a different rectangle entirely once
   * the copy has been resized.
   *
   * A `textPatch` has no `size`: its replacement is set at a font size and
   * sits on the line's own baseline, so there is no box to drag.
   */
  const size = 'size' in o ? o.size : undefined
  const at = {
    x: o.rect.x + dx,
    y: o.rect.y + dy,
    w: size?.w ?? o.rect.w,
    h: size?.h ?? o.rect.h,
  }
  return pageRectToView(at, g, zoom)
}
