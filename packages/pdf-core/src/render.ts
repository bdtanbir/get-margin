import * as mupdf from 'mupdf'
import { pageViewSize } from '@margin/transform'
import type { PdfDocument } from './engine.js'

/**
 * Whether MuPDF's toPixmap() applies the page's /Rotate itself.
 *
 * Confirmed three independent ways (docs/findings/01-read-path.md Q6,
 * cross-checked against `.superpowers/sdd/PLAN-PHASE-0-1/engine-facts.md`):
 * pixmap dimensions swap for 90/270, visual inspection of rendered pages,
 * and getTransform() already containing the rotation term. Composing an
 * extra rotation into the matrix passed to toPixmap would double-rotate.
 * The "agrees with pageViewSize for every rotation" test is the arbiter:
 * if it fails with swapped dimensions on the 90/270 pages, this is wrong.
 */
export const MUPDF_APPLIES_ROTATION = true

export type RenderedPage = {
  width: number
  height: number
  /** RGBA, 4 bytes per pixel, row-major, top-left origin. Ready for ImageData. */
  rgba: Uint8Array
}

export function renderPage(doc: PdfDocument, index: number, scale: number): RenderedPage {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError(`scale must be a positive finite number, got ${scale}`)
  }
  const geom = doc.pageGeometry(index) // also validates the index and range
  const page = doc._raw().loadPage(index)
  let pixmap: mupdf.Pixmap | undefined
  try {
    // MUPDF_APPLIES_ROTATION is true (see comment above): the engine bakes
    // /Rotate into toPixmap() itself, so the matrix passed here is scale-only.
    // Composing an extra rotation would double-rotate. The render/layout
    // cross-check below is what actually detects the engine changing this
    // behaviour.
    const matrix = mupdf.Matrix.scale(scale, scale)
    // alpha=true: ImageData requires 4 channels (putImageData/createImageBitmap).
    pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, true, true)

    const width = pixmap.getWidth()
    const height = pixmap.getHeight()
    const src = pixmap.getPixels()
    const stride = pixmap.getStride()
    const expectedRgba = width * height * 4
    const expectedRgb = width * height * 3

    // Determine the actual channel layout before trusting the stride, rather
    // than assuming 4 just because we asked for alpha=true.
    let bytesPerPixel: 3 | 4
    if (src.length === expectedRgba) {
      bytesPerPixel = 4
    } else if (src.length === expectedRgb) {
      bytesPerPixel = 3
    } else {
      throw new Error(
        `unexpected pixmap layout: ${src.length} bytes for ${width}x${height} ` +
        `(expected ${expectedRgba} RGBA or ${expectedRgb} RGB)`,
      )
    }

    // Guard the stride: a padded row copied as if contiguous produces a
    // progressively sheared image, which reads as a rendering artifact and
    // is miserable to trace back to this assumption.
    if (stride !== width * bytesPerPixel) {
      throw new Error(
        `pixmap stride ${stride} does not match width(${width}) x bytesPerPixel(${bytesPerPixel}) ` +
        `= ${width * bytesPerPixel}; refusing to copy a padded pixmap as if it were contiguous`,
      )
    }

    let rgba: Uint8Array
    if (bytesPerPixel === 4) {
      // Measured (mupdf 1.28.0, this task): with alpha=true, toPixmap clears
      // the buffer to fully transparent (0,0,0,0) rather than painting an
      // opaque white background, and paints premultiplied-alpha content on
      // top — verified by sampling a filled rectangle's interior (alpha=255,
      // colour matches the alpha=false render exactly) against its
      // surrounding blank area (0,0,0,0). A raw copy would hand the browser
      // a page that's mostly invisible instead of mostly white, which is not
      // what RenderedPage promises or what "opaque alpha" in the interface
      // doc means. So flatten: composite premultiplied colour over opaque
      // white (`premult + (255 - alpha)`, which is a no-op at alpha=255 and
      // yields white at alpha=0) and force the output alpha to fully opaque,
      // because RenderedPage represents a rendered page bitmap, not a page
      // with real transparency.
      rgba = new Uint8Array(expectedRgba)
      for (let p = 0; p < expectedRgba; p += 4) {
        const a = src[p + 3] ?? 0
        const inv = 255 - a
        rgba[p] = Math.min(255, (src[p] ?? 0) + inv)
        rgba[p + 1] = Math.min(255, (src[p + 1] ?? 0) + inv)
        rgba[p + 2] = Math.min(255, (src[p + 2] ?? 0) + inv)
        rgba[p + 3] = 255
      }
    } else {
      // Defensive: some builds return RGB despite alpha=true. Measured
      // alpha=false output is already opaque and composited over white, so
      // this is a straight channel-count expansion, no flattening needed.
      rgba = new Uint8Array(expectedRgba)
      for (let p = 0, s = 0; p < expectedRgba; p += 4, s += 3) {
        rgba[p] = src[s] ?? 0
        rgba[p + 1] = src[s + 1] ?? 0
        rgba[p + 2] = src[s + 2] ?? 0
        rgba[p + 3] = 255
      }
    }

    // Sanity-check against the view layer's expectation. A mismatch here means
    // MUPDF_APPLIES_ROTATION is wrong, and every later layout bug traces to it.
    const view = pageViewSize(geom, scale)
    if (Math.abs(width - view.width) > 1.5 || Math.abs(height - view.height) > 1.5) {
      throw new Error(
        `render/layout disagreement on page ${index} (rotate ${geom.rotate}): ` +
        `pixmap ${width}x${height} vs pageViewSize ${view.width}x${view.height}. ` +
        `Check MUPDF_APPLIES_ROTATION against docs/findings/01-read-path.md Q6.`,
      )
    }

    return { width, height, rgba }
  } finally {
    pixmap?.destroy()
    page.destroy()
  }
}
