/**
 * A glyph's box, with an impossible height pulled back to a believable one.
 *
 * MuPDF sizes each character's quad from its font's declared ascent and
 * descent. A font that declares nonsense gets nonsense boxes. The reported
 * case was a Word letter edited afterwards: the editing tool embedded new
 * Cambria subsets declaring an ascent of 3117 and a descent of -2464 (real
 * Cambria: 950 and -222), so every character in them was 67pt tall at 12pt.
 * The line holding "eil-bcms-121" became a box four lines deep. Clicking it
 * painted a cover over the WHOLE box, wiping the next line of the paragraph,
 * and its click target sat on top of its neighbours'.
 *
 * Viewers never notice, because drawing a glyph does not use those numbers.
 * Everything here that asks "where is this line?" does.
 *
 * WHAT COUNTS AS IMPOSSIBLE: taller than MAX_HEIGHT times the font size.
 * Ordinary text faces run 1.1 to 1.4, and tall accented or script faces
 * stay under 2. The broken subsets were 5.6. Anything under the limit is
 * returned untouched, so a well-made document extracts exactly as before.
 *
 * WHAT REPLACES IT: the same quad, rebuilt across the line from the pen
 * position, ASCENT above the baseline and DESCENT below, measured in the
 * glyph's own up direction so a turned or rotated run is corrected along
 * its own axis rather than the page's. Its extent ALONG the line is kept:
 * advance widths come from the glyph widths, which were fine.
 *
 * ONE FUNCTION for both readers: `buildQuadIndex`, which the editor draws
 * click targets and covers from, and the text-patch writer, which
 * re-derives the cover at export. If only one capped, the cover on screen
 * and the cover in the exported file would be different sizes.
 */

/** Taller than this many times the font size is a broken font, not a tall glyph. */
export const MAX_HEIGHT = 2

/** What a broken glyph is rebuilt with, as fractions of the font size. */
export const ASCENT = 0.95
export const DESCENT = 0.25

/**
 * `quad` is MuPDF's: upper-left, upper-right, lower-left, lower-right, as
 * eight numbers in page space. `origin` is the pen position, which sits on
 * the baseline. Returns the same array when nothing needed fixing.
 */
export function saneQuad(
  quad: readonly number[],
  origin: readonly number[],
  size: number,
): number[] {
  const out = [...quad]
  if (!(size > 0) || quad.length < 8) return out
  // Up the glyph: lower-left to upper-left.
  const ux = quad[0]! - quad[4]!
  const uy = quad[1]! - quad[5]!
  const height = Math.hypot(ux, uy)
  if (height <= MAX_HEIGHT * size) return out
  const nx = ux / height
  const ny = uy / height
  const ox = origin[0] ?? quad[4]!
  const oy = origin[1] ?? quad[5]!
  // Each corner: drop its distance across the line, put back the sane one.
  const fix = (i: number, across: number): void => {
    const t = (quad[i]! - ox) * nx + (quad[i + 1]! - oy) * ny
    out[i] = quad[i]! + (across - t) * nx
    out[i + 1] = quad[i + 1]! + (across - t) * ny
  }
  fix(0, ASCENT * size)
  fix(2, ASCENT * size)
  fix(4, -DESCENT * size)
  fix(6, -DESCENT * size)
  return out
}
