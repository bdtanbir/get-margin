import type { Color } from '@margin/pdf-core'

/** Anything with the shape of a render result. Keeps this testable without one. */
export type Pixels = { width: number; height: number; rgba: Uint8Array }

/** The paper colour assumed when a page has not rendered yet, or is not uniform. */
export const WHITE: Color = [1, 1, 1]

/** Two colours the same to within a quantisation step of 8-bit channels. */
export function sameColor(a: Color, b: Color, tolerance = 3 / 255): boolean {
  return a.every((n, i) => Math.abs(n - b[i]!) <= tolerance)
}

/**
 * Read one pixel, COMPOSITED OVER WHITE.
 *
 * The renderer produces RGBA with alpha (render.ts), so a page that paints
 * nothing comes back transparent rather than white -- and a viewer, like our
 * own preview, shows white paper there. Compositing here means "unpainted"
 * and "painted white" give the same answer, which is what a reader sees and
 * therefore what the paper colour has to mean.
 */
function pixelAt(bitmap: Pixels, x: number, y: number): Color {
  const i = (y * bitmap.width + x) * 4
  const a = (bitmap.rgba[i + 3] ?? 0) / 255
  return [0, 1, 2].map((c) => {
    const v = (bitmap.rgba[i + c] ?? 0) / 255
    return v * a + (1 - a)
  }) as Color
}

/**
 * The colour of a page's paper, read off its render.
 *
 * WHY THIS EXISTS: a background is stored as a multiplier, not as a colour,
 * so the swatch cannot simply show what is stored -- it has to show what the
 * page actually looks like. And on a page whose colour is already baked into
 * the file (open a document you exported a background onto, and it is), there
 * is nothing stored at all. Reading the render answers both cases with one
 * rule, and it is the only source that knows what the reader is looking at.
 *
 * THE FOUR CORNERS, and they must agree. A page's outermost pixels are its
 * margin in every layout that has one, so they are the best available witness
 * to the paper. Requiring agreement is what stops a full-bleed photograph or
 * a coloured header band from being reported as the paper colour: when the
 * corners disagree the page has no single paper colour, and white -- what an
 * unpainted PDF page is -- is the honest answer rather than a guess taken
 * from whichever corner was sampled first.
 *
 * Inset by a pixel: the outermost row can carry an antialiased edge from the
 * page boundary itself, which is not paper and not content.
 */
export function detectPaper(bitmap: Pixels | undefined): Color {
  if (!bitmap || bitmap.width < 4 || bitmap.height < 4) return WHITE
  const x0 = 1
  const y0 = 1
  const x1 = bitmap.width - 2
  const y1 = bitmap.height - 2
  const corners = [
    pixelAt(bitmap, x0, y0),
    pixelAt(bitmap, x1, y0),
    pixelAt(bitmap, x0, y1),
    pixelAt(bitmap, x1, y1),
  ]
  const first = corners[0]!
  return corners.every((c) => sameColor(c, first)) ? first : WHITE
}

/**
 * The multiplier that takes `paper` to `target`.
 *
 * A background is written as a Multiply fill, so what reaches the page is
 * `paper x factor` -- and on the ordinary white page that is just the colour
 * the user picked. It stops being just the colour the moment the paper is not
 * white, which is exactly the case that made a second background look like a
 * dirty overlay instead of a new colour: picking dark red on a page already
 * red gave red x dark red, not dark red.
 *
 * Dividing the paper out fixes that wherever it can be fixed. A channel the
 * paper has none of cannot be raised -- multiplying by anything leaves zero --
 * so it clamps to 1, meaning "leave this channel alone"; `reachable` below is
 * how the UI says so rather than quietly producing mud.
 */
export function multiplyFactor(target: Color, paper: Color): Color {
  return target.map((t, i) => {
    const p = paper[i]!
    if (p <= 0) return 1
    return Math.min(1, t / p)
  }) as Color
}

/** What `paper` becomes once `factor` is multiplied over it. */
export function applyFactor(paper: Color, factor: Color): Color {
  return paper.map((p, i) => p * factor[i]!) as Color
}

/**
 * Whether `target` is a colour this page can actually be made.
 *
 * Multiply only ever darkens. A page whose paper is already coloured can be
 * taken further down but never back up, and no factor exists that turns a red
 * sheet blue -- the red channel would have to be raised from zero.
 */
export function reachable(target: Color, paper: Color, tolerance = 1 / 255): boolean {
  return target.every((t, i) => t <= paper[i]! + tolerance)
}

/** The identity factor: a background that changes nothing. */
export function isNeutral(factor: Color): boolean {
  return sameColor(factor, WHITE, 0)
}
