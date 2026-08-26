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
 * WHY THIS EXISTS: the swatch cannot show the stored colour, because a
 * background is MULTIPLIED over the page rather than replacing it -- what the
 * reader sees is `paper x stored`, and on a page that was not white to begin
 * with those are two different colours. And on a page whose colour is already
 * baked into the file (open a document you exported a background onto, and it
 * is), there is nothing stored at all. Reading the render answers both cases
 * with one rule, and it is the only source that knows what is on screen.
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
 * WHY THERE IS NO "DIVIDE THE EXISTING PAPER OUT" FUNCTION HERE.
 *
 * There was one, briefly. Given a detected paper P and a target C it returned
 * `clamp(C / P)`, so that `P x factor` landed on C -- which fixes picking a
 * second colour on a page that already has one, as long as the page has ONE
 * paper colour. Real pages do not. The document that prompted it renders its
 * margin at (235,115,0) and its card interior at (255,255,255): two papers on
 * one page, and the corners can only witness the first.
 *
 * The clamp is what made that fatal rather than merely approximate. A channel
 * the sampled paper has none of divides to infinity, so it clamped to 1 --
 * "leave this channel alone" -- and on orange, blue clamps to 1. Correct on
 * the orange margin, and on the white card it left blue at full strength: the
 * user asked for red and got a magenta card.
 *
 * A plain Multiply by the colour has no such failure mode. It can only ever
 * darken, and it can never introduce a channel the page did not already have,
 * so every region of a multi-paper page moves toward the same colour instead
 * of each acquiring its own cast. It is the weaker operation and it is the
 * one that is always right.
 */

/** What `paper` becomes once `tint` is multiplied over it. */
export function applyTint(paper: Color, tint: Color): Color {
  return paper.map((p, i) => p * tint[i]!) as Color
}

/**
 * Whether tinting `paper` with `target` gets somewhere the user would accept
 * as the colour they picked.
 *
 * Multiply only ever darkens, so a page whose paper is already coloured can
 * be taken further down but never back up: no tint turns a red sheet blue,
 * because the blue channel would have to be raised from zero.
 *
 * Judged on the RESULT, not on whether every channel fits. "Fits" is true or
 * false at a hair's width, and a page whose margin renders at 235 rather than
 * 255 fails it while coming out a red nobody could distinguish from the one
 * they asked for. What matters is whether the answer is visibly the wrong
 * colour -- red on orange misses by 0.08 and blue on orange misses by 1.0, so
 * a threshold in between separates a rounding error from black.
 */
export function reachable(target: Color, paper: Color, tolerance = 0.15): boolean {
  return sameColor(applyTint(paper, target), target, tolerance)
}

/** White: the tint that changes nothing, whatever the page underneath is. */
export function isNeutral(tint: Color): boolean {
  return sameColor(tint, WHITE, 0)
}
