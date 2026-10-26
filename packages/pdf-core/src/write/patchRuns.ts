import type { Color, PatchSpan, TextPatchObject } from './types.js'
import { weightOf } from './fonts.js'

/**
 * One piece of a text patch with every style axis resolved: what the
 * writer draws and the overlay previews, piece by piece.
 *
 * ONE RESOLVER for both, for the reason every shared helper in this format
 * exists: if the preview and the export read `spans` differently, the
 * line on screen and the line in the file would be different lines.
 */
export type PatchRun = {
  text: string
  weight: number
  italic: boolean
  /** Fraction of the patch's size. */
  scale: number
  /** Baseline raise, as a fraction of the patch's size. Positive is up. */
  rise: number
  color: Color
}

/** Whether a span list is usable for `text`: its pieces must spell it exactly. */
export function spansMatch(spans: readonly PatchSpan[] | undefined, text: string): boolean {
  return !!spans && spans.length > 0 && spans.map((s) => s.text).join('') === text
}

/**
 * The patch's text as styled runs, in order. One run when the patch has
 * no usable spans. Empty pieces are dropped: they draw nothing and would
 * only cost a font switch.
 */
export function patchRuns(
  o: Pick<TextPatchObject, 'text' | 'weight' | 'italic' | 'color' | 'spans'>,
): PatchRun[] {
  const base = { weight: weightOf(o), italic: o.italic === true, color: o.color }
  if (!spansMatch(o.spans, o.text)) {
    return [{ text: o.text, ...base, scale: 1, rise: 0 }]
  }
  return o.spans!.filter((s) => s.text !== '').map((s) => ({
    text: s.text,
    weight: s.weight ?? base.weight,
    italic: s.italic ?? base.italic,
    scale: s.scale ?? 1,
    rise: s.rise ?? 0,
    color: s.color ?? base.color,
  }))
}

/**
 * Cut runs down to their first `count` code points, for the `truncate`
 * fit. Code points rather than UTF-16 units, so a character outside the
 * BMP is never split in half.
 */
export function truncateRuns(runs: readonly PatchRun[], count: number): PatchRun[] {
  const out: PatchRun[] = []
  let left = count
  for (const run of runs) {
    if (left <= 0) break
    const chars = [...run.text]
    out.push(chars.length <= left ? run : { ...run, text: chars.slice(0, left).join('') })
    left -= chars.length
  }
  return out
}

/**
 * The width runs take up at `size`: each run's own advance, plus the
 * letter spacing between every pair of characters -- including the pair
 * either side of a run boundary, which is still a gap between two glyphs.
 */
export function runsAdvance(
  runs: readonly PatchRun[],
  size: number,
  spacing: number,
  measure: (run: PatchRun, size: number) => number,
): number {
  let width = 0
  let chars = 0
  for (const run of runs) {
    width += measure(run, size * run.scale)
    chars += [...run.text].length
  }
  return width + spacing * Math.max(0, chars - 1)
}
