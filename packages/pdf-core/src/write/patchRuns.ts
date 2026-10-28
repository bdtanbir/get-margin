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

/** Line spacing for a block with no paragraph to take it from. */
const DEFAULT_LEADING = 1.2

/**
 * How a patch's text is broken into lines, or undefined for a ONE-LINE
 * patch -- drawn exactly as before paragraphs existed, `fit` and all.
 *
 * A patch is a block when it replaces a paragraph, or when its text has a
 * line break in it (Enter in a single line's field).
 */
export function blockLayout(
  o: Pick<TextPatchObject, 'text' | 'paragraph'>,
): { width: number; leading: number; indent: number } | undefined {
  const p = o.paragraph
  if (!p && !o.text.includes('\n')) return undefined
  return {
    width: p && p.width > 0 ? p.width : 0,
    leading: p && p.leading > 0 ? p.leading : DEFAULT_LEADING,
    indent: p && p.indent > 0 ? p.indent : 0,
  }
}

type Piece = { run: PatchRun; space: boolean }

const sameRunStyle = (a: PatchRun, b: PatchRun): boolean =>
  a.weight === b.weight && a.italic === b.italic && a.scale === b.scale &&
  a.rise === b.rise && a.color.every((v, i) => v === b.color[i])

function joinPieces(pieces: readonly Piece[]): PatchRun[] {
  const out: PatchRun[] = []
  for (const { run } of pieces) {
    if (run.text === '') continue
    const last = out[out.length - 1]
    if (last && sameRunStyle(last, run)) out[out.length - 1] = { ...last, text: last.text + run.text }
    else out.push(run)
  }
  return out
}

/**
 * Break runs into lines: at every `\n`, and -- when `width` is above 0 --
 * wherever the next word would pass `width`. The first line has
 * `width - indent` to fill.
 *
 * ONE implementation for the writer and the preview: if they broke lines
 * in different places, the paragraph on screen and in the file would be
 * different paragraphs.
 *
 * Greedy, as every editor wraps. Spaces at a soft break are swallowed;
 * spaces the user typed at the start of a hard line are kept. A word wider
 * than a whole line is broken between characters rather than left to
 * overflow.
 */
export function layoutRuns(
  runs: readonly PatchRun[],
  opts: {
    width: number
    indent: number
    size: number
    spacing: number
    measure: (run: PatchRun, size: number) => number
  },
): PatchRun[][] {
  // Hard lines first.
  const hard: Piece[][] = [[]]
  for (const run of runs) {
    run.text.split('\n').forEach((part, i) => {
      if (i > 0) hard.push([])
      for (const token of part.split(/(\s+)/)) {
        if (token !== '') hard[hard.length - 1]!.push({ run: { ...run, text: token }, space: /^\s+$/.test(token) })
      }
    })
  }

  const widthOf = (p: Piece): number =>
    opts.measure(p.run, opts.size * p.run.scale) + opts.spacing * [...p.run.text].length

  const lines: PatchRun[][] = []
  const room = (): number => (lines.length === 0 ? opts.width - opts.indent : opts.width)

  for (const pieces of hard) {
    if (opts.width <= 0) { lines.push(joinPieces(pieces)); continue }
    let line: Piece[] = []
    let used = 0
    let soft = false
    const flush = (): void => {
      while (line.length > 0 && line[line.length - 1]!.space) line.pop()
      lines.push(joinPieces(line))
      line = []
      used = 0
      soft = true
    }
    for (const piece of pieces) {
      if (piece.space) {
        // Swallowed at the start of a line the wrap made, kept otherwise.
        if (line.length === 0 && soft) continue
        line.push(piece)
        used += widthOf(piece)
        continue
      }
      const w = widthOf(piece)
      if (used + w <= room() || !line.some((p) => !p.space) && w <= room()) {
        line.push(piece)
        used += w
        continue
      }
      if (line.some((p) => !p.space)) flush()
      if (w <= room()) { line.push(piece); used = w; continue }
      // A word longer than a line: as many characters as fit, then the rest.
      let rest = [...piece.run.text]
      while (rest.length > 0) {
        let n = 1
        while (n < rest.length &&
          widthOf({ run: { ...piece.run, text: rest.slice(0, n + 1).join('') }, space: false }) <= room() - used) n++
        const head: Piece = { run: { ...piece.run, text: rest.slice(0, n).join('') }, space: false }
        rest = rest.slice(n)
        line.push(head)
        used += widthOf(head)
        if (rest.length > 0) flush()
      }
    }
    while (line.length > 0 && line[line.length - 1]!.space && soft) line.pop()
    lines.push(joinPieces(line))
  }
  return lines
}
