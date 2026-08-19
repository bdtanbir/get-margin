import type { Rect } from '@margin/transform'

export type Bitmap = { width: number; height: number; rgba: Uint8Array | Uint8ClampedArray }

export type BackgroundSample = {
  /** sRGB, each channel 0..1 — the writer's colour format. */
  color: [number, number, number]
  /**
   * 0..1. How uniform the sampled pixels were.
   *
   * High means a flat colour that a rectangle can imitate exactly. Low
   * means the area varied -- a gradient, a photograph, a texture, a rule
   * running through the line -- where covering with one flat colour leaves
   * a visible scar. The number exists so the UI can say so BEFORE the user
   * commits, rather than leaving them to find it in the exported file.
   */
  confidence: number
  /** How many pixels the estimate is based on. Zero means it is a guess. */
  samples: number
}

/** White, the honest default when there is nothing to sample. */
const WHITE: [number, number, number] = [1, 1, 1]

/**
 * The colour behind a line of text, sampled from the rendered page.
 *
 * Sampled from a BAND AROUND the line rather than from inside it. Inside is
 * mostly glyphs, so an average taken there is a blend of ink and paper --
 * which on black-on-white text produces grey, and covering with grey is
 * worse than not covering at all.
 *
 * Done in the app rather than in the writer because the app already has
 * the page rendered on screen. The writer would have to rasterise a page
 * per patch to learn the same thing.
 *
 * `scale` converts the line's page-space box (points) to bitmap pixels: a
 * bitmap rendered at 2x has twice as many pixels per point.
 */
export function sampleBackground(
  bitmap: Bitmap | undefined,
  bbox: Rect,
  scale: number,
): BackgroundSample {
  if (!bitmap || bitmap.width === 0 || bitmap.height === 0) {
    return { color: WHITE, confidence: 0, samples: 0 }
  }

  const { width, height, rgba } = bitmap
  const x0 = Math.round(bbox.x * scale)
  const y0 = Math.round(bbox.y * scale)
  const x1 = Math.round((bbox.x + bbox.w) * scale)
  const y1 = Math.round((bbox.y + bbox.h) * scale)

  // A band as tall as a third of the line, which is enough to clear the
  // glyphs' antialiased edges without reaching into whatever is above or
  // below.
  const band = Math.max(2, Math.round((y1 - y0) / 3))

  const reds: number[] = []
  const greens: number[] = []
  const blues: number[] = []

  const take = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const at = (y * width + x) * 4
    const r = rgba[at]
    const g = rgba[at + 1]
    const b = rgba[at + 2]
    if (r === undefined || g === undefined || b === undefined) return
    reds.push(r)
    greens.push(g)
    blues.push(b)
  }

  // Above and below the line, across its full width.
  for (let x = x0; x < x1; x++) {
    for (let d = 1; d <= band; d++) {
      take(x, y0 - d)
      take(x, y1 + d)
    }
  }
  // Left and right of it, over its full height -- a line indented into a
  // coloured panel has its colour beside it even when the rows above and
  // below belong to something else.
  for (let y = y0; y < y1; y++) {
    for (let d = 1; d <= band; d++) {
      take(x0 - d, y)
      take(x1 + d, y)
    }
  }

  if (reds.length === 0) return { color: WHITE, confidence: 0, samples: 0 }

  // MEDIAN, not mean. A rule, a border, or a descender poking into the band
  // drags a mean away from the paper colour, while a median ignores a
  // minority of outliers entirely -- which is exactly what those are.
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]!
  }
  const mr = median(reds)
  const mg = median(greens)
  const mb = median(blues)

  // Confidence from the mean absolute deviation around that median, which
  // is the "is this area flat" question stated directly. Normalised against
  // a deviation of 24/255 -- about the point where a flat cover starts to
  // be visible against what it covers.
  let deviation = 0
  for (let i = 0; i < reds.length; i++) {
    deviation += Math.abs(reds[i]! - mr) + Math.abs(greens[i]! - mg) + Math.abs(blues[i]! - mb)
  }
  deviation /= reds.length * 3
  const confidence = Math.max(0, Math.min(1, 1 - deviation / 24))

  return {
    color: [mr / 255, mg / 255, mb / 255],
    confidence,
    samples: reds.length,
  }
}

/**
 * Below this, a flat cover is likely to show.
 *
 * Chosen so an ordinary page of black text on white -- where the band is
 * near-uniform paper -- sits comfortably above it, while a gradient or a
 * photograph falls below.
 */
export const CONFIDENT_ENOUGH = 0.75
