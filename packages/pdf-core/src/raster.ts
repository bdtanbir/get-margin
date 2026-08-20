import * as mupdf from 'mupdf'
import { pageViewSize } from '@margin/transform'
import type { PdfDocument } from './engine.js'

export type RasterFormat = 'jpeg' | 'png'

/**
 * PDF user space is 72 units to the inch, by definition. Every DPI figure
 * a user picks is this divided into it.
 */
export const PDF_UNITS_PER_INCH = 72

/** What the dialog offers, and what each choice is actually for. */
export const DPI_PRESETS = [
  { dpi: 72, label: 'Screen', note: 'Smallest file' },
  { dpi: 150, label: 'Good', note: 'Reads well on any screen' },
  { dpi: 300, label: 'Print', note: 'Largest file' },
] as const

/** JPEG quality, 0-100. 85 is the usual knee: visually clean, and half the bytes of 95. */
export const DEFAULT_JPEG_QUALITY = 85

/**
 * MuPDF's rounding fudge when it turns a page rectangle into whole pixels.
 *
 * `fz_round_rect` computes `ceil(edge - 0.001)`, not `round(edge)`, so a
 * page 595.276pt wide renders 596 pixels at 72 DPI while a page 50.001pt
 * tall renders 50. Measured across 48 combinations of page box and DPI --
 * plain rounding disagreed with the engine on half of them.
 *
 * This is an ENGINE FACT, in the same category as MUPDF_APPLIES_ROTATION:
 * it is not derivable from the spec, and the matrix test in
 * `test/raster.test.ts` is what detects the engine changing it.
 */
export const MUPDF_ROUND_EPSILON = 0.001

/**
 * The whole pixels MuPDF will produce for one page dimension.
 *
 * `pt * dpi / 72` rather than `pt * (dpi / 72)`: the intermediate scale is
 * not exactly representable, so 612 x (150/72) lands on 1275.0000000000002
 * and would ceil to 1276.
 */
export function rasterPixels(sizePt: number, dpi: number): number {
  return Math.ceil((sizePt * dpi) / PDF_UNITS_PER_INCH - MUPDF_ROUND_EPSILON)
}

export type RasteriseOptions = {
  /** JPEG only. Ignored for PNG, which is lossless. */
  quality?: number
}

export type RasterisedPage = {
  bytes: Uint8Array
  width: number
  height: number
  format: RasterFormat
}

/**
 * One page, as an image.
 *
 * This is the whole of "PDF to JPG" -- there is no API involved, no queue,
 * and no upload. `PLAN.md` §3 lists it under client-side only, and the
 * pre-flight measured it between 48 ms and 455 ms across 72-300 DPI
 * (`docs/findings/16-phase-7-preflight.md`), which is fast enough that
 * making it a job would add latency rather than remove it.
 *
 * Rendered WITHOUT alpha, unlike `renderPage`. That function produces RGBA
 * for the screen and flattens premultiplied colour over white by hand;
 * here MuPDF's own alpha=false path already composites over white, which
 * is what both JPEG (no alpha channel at all) and a printed page want.
 */
export function rasterisePage(
  doc: PdfDocument,
  index: number,
  dpi: number,
  format: RasterFormat = 'jpeg',
  options: RasteriseOptions = {},
): RasterisedPage {
  if (!Number.isFinite(dpi) || dpi <= 0) {
    throw new RangeError(`dpi must be a positive finite number, got ${dpi}`)
  }
  // Validates the index and the range before a page is loaded, matching
  // renderPage's discipline.
  doc.pageGeometry(index)

  const scale = dpi / PDF_UNITS_PER_INCH
  const page = doc._raw().loadPage(index)
  let pixmap: mupdf.Pixmap | undefined
  try {
    // Scale only. MUPDF_APPLIES_ROTATION: the engine bakes /Rotate into
    // toPixmap itself, so composing a rotation here would double-rotate --
    // the same fact `render.ts` depends on, recorded in
    // docs/findings/01-read-path.md Q6.
    pixmap = page.toPixmap(
      mupdf.Matrix.scale(scale, scale),
      mupdf.ColorSpace.DeviceRGB,
      false,
      true,
    )

    const width = pixmap.getWidth()
    const height = pixmap.getHeight()
    const bytes =
      format === 'png'
        ? pixmap.asPNG()
        : pixmap.asJPEG(clampQuality(options.quality ?? DEFAULT_JPEG_QUALITY))

    return { bytes: new Uint8Array(bytes), width, height, format }
  } finally {
    pixmap?.destroy()
    page.destroy()
  }
}

/**
 * The pixel dimensions a page would have, without rendering it.
 *
 * The dialog needs this to say "2550 x 3300" before the user commits to
 * an export that could be a hundred megabytes. Rendering the page to find
 * out would defeat the purpose.
 */
export function rasterSize(
  doc: PdfDocument,
  index: number,
  dpi: number,
): { width: number; height: number } {
  const geom = doc.pageGeometry(index)
  // `pageViewSize` at zoom 1 gives the page's extent in POINTS, with the
  // quarter-turn dimension swap already applied -- so this reports the
  // image the reader will actually get, not the one the unrotated box
  // describes. The points-to-pixels step is `rasterPixels`, which has to
  // match the engine exactly rather than approximately: this number is
  // shown to the user before they commit to the export.
  const view = pageViewSize(geom, 1)
  return {
    width: rasterPixels(view.width, dpi),
    height: rasterPixels(view.height, dpi),
  }
}

function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) return DEFAULT_JPEG_QUALITY
  return Math.min(100, Math.max(1, Math.round(quality)))
}
