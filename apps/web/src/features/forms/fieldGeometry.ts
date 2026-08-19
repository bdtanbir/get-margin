import type { Rect } from '@margin/transform'

/**
 * A source field's rect as a CSS box on the page overlay.
 *
 * NO page transform, and that absence is the point. Every other Layer 3
 * component runs its rect through `pdfRectToView` because EditObject rects
 * are raw PDF user space (Convention B) and have to be flipped, offset, and
 * rotated into the space the overlay box describes.
 *
 * A SourceField's rect arrives from `getBounds()`, which is ALREADY that
 * space -- MuPDF page space, top-down, CropBox normalised, /Rotate applied
 * (docs/findings/12-phase-5-preflight.md 4). It is the same space
 * `svgViewBox` describes, so the only thing left to do is scale points to
 * pixels.
 *
 * Running it through `pdfRectToView` anyway would apply the page transform
 * a second time -- the same class of bug as putting markup quads inside
 * PageOverlay's flipped root <g>. This function exists as a named seam so
 * that decision is written down rather than implied by a bare multiply.
 */
export function fieldBox(rect: Rect, zoom: number): {
  left: string
  top: string
  width: string
  height: string
} {
  return {
    left: `${rect.x * zoom}px`,
    top: `${rect.y * zoom}px`,
    width: `${rect.w * zoom}px`,
    height: `${rect.h * zoom}px`,
  }
}
