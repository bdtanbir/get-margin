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

/**
 * How far a pixel may sit from the median and still count as the same
 * colour, per channel, 0..255.
 *
 * Wide enough to swallow the antialiasing and JPEG noise that make no two
 * pixels of "white paper" identical, narrow enough that two colours a
 * reader can tell apart are not counted as one.
 */
const FLAT_TOLERANCE = 12

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
  /**
   * The furthest the ring reaches from the box, in BITMAP PIXELS. Optional,
   * and without it the band is a third of the box's height as before.
   *
   * It exists for images. A third of a line of text is a few points of
   * paper; a third of a 100pt logo is 33pt of whatever else is on the page,
   * and a ring that reaches a table two centimetres away reports "the area
   * behind this is varied" for a cover that would have been invisible. The
   * median survives that; the confidence, which is what the UI warns on,
   * does not.
   *
   * A cap, never a floor: passing one larger than the natural band changes
   * nothing.
   */
  maxBand?: number,
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
  const natural = Math.max(2, Math.round((y1 - y0) / 3))
  const band = maxBand === undefined ? natural : Math.min(natural, Math.max(2, maxBand))

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

  /**
   * Confidence is the SHARE of the sampled paper that is already the
   * colour about to be painted.
   *
   * This used to be one minus the MEAN absolute deviation around the
   * median, and that contradicted the median two lines above it. The
   * median exists precisely so a rule, a border or a coloured bar in the
   * band cannot drag the answer; a mean deviation over the same pixels
   * hands them back all their influence, so the colour ignored the
   * outliers and the confidence did not.
   *
   * Measured on a real e-ticket: the US-Bangla logo sits on flat white
   * with a blue header bar a few points above it. The sample returned
   * white with a confidence of 0.105, so the tool warned that the paper
   * behind a logo on plain paper "is not a flat colour".
   *
   * A share answers the question the UI actually asks -- will a flat
   * rectangle of THIS colour look wrong here -- and it degrades the way
   * the warning needs it to: a quarter of the band being something else
   * still reads as flat paper, while a background that genuinely varies
   * has almost no pixels at any single colour and collapses towards zero.
   */
  let matching = 0
  for (let i = 0; i < reds.length; i++) {
    if (
      Math.abs(reds[i]! - mr) <= FLAT_TOLERANCE &&
      Math.abs(greens[i]! - mg) <= FLAT_TOLERANCE &&
      Math.abs(blues[i]! - mb) <= FLAT_TOLERANCE
    ) matching++
  }
  const confidence = matching / reds.length

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
