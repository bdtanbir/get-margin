import type { LineRun, PageQuadIndex } from '@margin/pdf-core'
import { lineBox } from './linePatch'

/**
 * Which lines of a page form the paragraph a clicked line belongs to.
 *
 * The extraction hands over LINES; the editor needs paragraphs so typed
 * text can wrap where the document's own text wrapped. MuPDF's text blocks
 * are the starting point, but a block can hold several paragraphs and one
 * visual row can be split into several lines (a bold label, then the rest
 * of its sentence), so the grouping is checked against geometry too.
 *
 * The rule throughout: when unsure, DON'T merge. A paragraph that is too
 * small edits like the old one-line editor; one that is too big would
 * redraw text the user never touched.
 *
 * See PARAGRAPH-EDIT-DESIGN.md.
 */

export type Rect = { x: number; y: number; w: number; h: number }

/** The lines on one baseline, left to right. */
type Row = {
  lines: number[]
  block: number
  size: number
  baseline: number
  x0: number
  x1: number
}

export type Paragraph = {
  /** Line indexes, first line first. */
  lines: number[]
  /** The union of the lines' boxes. */
  box: Rect
  /** Wrap width in points; 0 for "do not wrap". */
  width: number
  /** Baseline step as a multiple of the first line's size. */
  leading: number
  /** How far right of the other rows the first row starts. */
  indent: number
}

const sizeOf = (l: LineRun): number => (l.size > 0 ? l.size : lineBox(l).h * 0.8)

/** Rows of the page, in extraction order. */
function rowsOf(index: PageQuadIndex): Row[] {
  const rows: Row[] = []
  index.lines.forEach((line, i) => {
    if (line.chars.length === 0) return
    const b = lineBox(line)
    const size = sizeOf(line)
    const block = line.block ?? -1
    const last = rows[rows.length - 1]
    if (
      last &&
      Math.abs(last.baseline - line.baseline) < 0.3 * Math.max(size, last.size) &&
      b.x >= last.x1 - 0.5 * size &&
      // About a word space apart, no more: table cells and a contents
      // page's leader-less page numbers sit on one baseline too, and
      // joining those would flatten the table into a sentence.
      b.x - last.x1 <= 1.5 * size
    ) {
      last.lines.push(i)
      last.x1 = Math.max(last.x1, b.x + b.w)
      return
    }
    rows.push({ lines: [i], block, size, baseline: line.baseline, x0: b.x, x1: b.x + b.w })
  })
  return rows
}

const similarSize = (a: number, b: number): boolean => Math.abs(a - b) <= 0.15 * Math.max(a, b)

/**
 * What the page says about itself: how many rows each MuPDF block holds,
 * and the usual baseline step.
 *
 * Blocks are only evidence when they hold several rows. Plenty of
 * generators -- Word's PDF export among them -- put every line in a block
 * of its own, and there "different block" says nothing about paragraphs.
 */
type PageFacts = { rowsInBlock: Map<number, number>; step: (size: number) => number | undefined }

function factsOf(rows: Row[]): PageFacts {
  const rowsInBlock = new Map<number, number>()
  for (const r of rows) rowsInBlock.set(r.block, (rowsInBlock.get(r.block) ?? 0) + 1)
  return { rowsInBlock, step: (size) => typicalStep(rows, size) }
}

const blocksAgree = (facts: PageFacts, a: Row, b: Row): boolean =>
  a.block === b.block ||
  (facts.rowsInBlock.get(a.block) === 1 && facts.rowsInBlock.get(b.block) === 1)

/** Whether `next` continues the paragraph made of `rows`. */
function continues(rows: Row[], next: Row, facts: PageFacts): boolean {
  const first = rows[0]!
  const prev = rows[rows.length - 1]!
  if (!blocksAgree(facts, prev, next) || !similarSize(next.size, first.size)) return false
  const step = next.baseline - prev.baseline
  if (step < 0.9 * first.size || step > 3 * first.size) return false
  // A gap well past the page's usual line spacing is a paragraph break.
  // With too little on the page to know its spacing, anything past double
  // spacing is a break -- two headings a line apart are not a paragraph.
  const usual = facts.step(first.size)
  if (step > (usual !== undefined ? usual * 1.3 : 2.2 * first.size)) return false
  if (rows.length >= 2) {
    const firstStep = rows[1]!.baseline - first.baseline
    if (Math.abs(step - firstStep) > 0.25 * first.size) return false
  }
  // Left edges: the second row may sit LEFT of an indented first row;
  // after that every row lines up with the one before.
  const tolerance = 0.6 * first.size
  if (rows.length === 1) {
    if (next.x0 > prev.x0 + tolerance || next.x0 < prev.x0 - 4 * first.size) return false
  } else if (Math.abs(next.x0 - prev.x0) > tolerance) {
    return false
  }
  // A row well short of the paragraph's widest is its LAST row: what
  // follows starts a new paragraph, even at the same spacing.
  const left = Math.min(...rows.map((r) => r.x0), next.x0)
  const widest = Math.max(...rows.map((r) => r.x1)) - left
  if (rows.length >= 2 && prev.x1 - left < 0.75 * widest) return false
  return true
}

function union(boxes: Rect[]): Rect {
  const x0 = Math.min(...boxes.map((b) => b.x))
  const y0 = Math.min(...boxes.map((b) => b.y))
  const x1 = Math.max(...boxes.map((b) => b.x + b.w))
  const y1 = Math.max(...boxes.map((b) => b.y + b.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * The widest line on the page that starts at `left` in about the same
 * size: the column's measure, for a paragraph whose own lines are ragged
 * or for a single line with nothing of its own to go by.
 */
function columnWidth(rows: Row[], left: number, size: number): number {
  let best = 0
  for (const r of rows) {
    if (Math.abs(r.x0 - left) <= 1.5 && similarSize(r.size, size)) best = Math.max(best, r.x1 - left)
  }
  return best
}

/**
 * The page's usual baseline step at `size`, in points, if it has one: the
 * median, so the bigger gaps between paragraphs do not count.
 */
function typicalStep(rows: Row[], size: number): number | undefined {
  const steps: number[] = []
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!
    const b = rows[i]!
    if (!similarSize(a.size, size) || !similarSize(b.size, size)) continue
    const step = b.baseline - a.baseline
    if (step >= 0.9 * size && step <= 3 * size) steps.push(step)
  }
  // Two or three steps say nothing about the page; one of them may well
  // be the gap between two paragraphs.
  if (steps.length < 3) return undefined
  steps.sort((x, y) => x - y)
  return steps[Math.floor((steps.length - 1) / 2)]
}

/**
 * The paragraph `lineIndex` is in.
 *
 * `taken(i)` says a line already has its own patch: a paragraph never
 * swallows one, because two patches over one line each cover the other
 * (see `patchOnLine`). It stops at a taken row, and when the clicked
 * line's own row has a taken line in it, the clicked line stands alone.
 */
export function paragraphAt(
  index: PageQuadIndex,
  lineIndex: number,
  taken: (i: number) => boolean = () => false,
): Paragraph | undefined {
  const line = index.lines[lineIndex]
  if (!line || line.chars.length === 0) return undefined
  const rows = rowsOf(index)

  // Paragraphs over the whole page, so the clicked row lands in the one
  // that STARTS where the document's paragraph starts.
  const facts = factsOf(rows)
  const groups: Row[][] = []
  for (const row of rows) {
    const current = groups[groups.length - 1]
    if (current && continues(current, row, facts)) current.push(row)
    else groups.push([row])
  }

  const at = rows.findIndex((r) => r.lines.includes(lineIndex))
  const clickedRow = rows[at]!
  let group = groups.find((g) => g.includes(clickedRow))!
  if (clickedRow.lines.some(taken)) {
    group = [{ ...clickedRow, lines: [lineIndex] }]
  } else {
    // Cut down to the untaken rows around the clicked one.
    const k = group.indexOf(clickedRow)
    let a = k
    let b = k
    while (a > 0 && !group[a - 1]!.lines.some(taken)) a--
    while (b < group.length - 1 && !group[b + 1]!.lines.some(taken)) b++
    group = group.slice(a, b + 1)
  }

  const lines = group.flatMap((r) => r.lines)
  const first = group[0]!
  const size = sizeOf(index.lines[lines[0]!]!)
  const box = union(lines.map((i) => lineBox(index.lines[i]!)))
  const rest = group.length > 1 ? group.slice(1) : group
  const left = Math.min(...rest.map((r) => r.x0))
  const indent = Math.max(0, first.x0 - left)
  const ownWidth = Math.max(...group.map((r) => r.x1)) - left
  // A single row wraps at its column when it has one wider than itself,
  // and not at all when it does not -- a lone heading has nothing to wrap to.
  const column = columnWidth(rows, left, size)
  const width = group.length > 1
    ? Math.max(ownWidth, column) + 1
    : column > ownWidth + 0.5 ? column + 1 : 0
  const leading = group.length > 1
    ? (group[1]!.baseline - first.baseline) / size
    : (facts.step(size) ?? 1.2 * size) / size

  return { lines, box, width, leading, indent }
}

/**
 * A paragraph's text, joined the way the editor shows it: lines on one
 * row by a space where there is a gap between them, rows by a space, and a
 * row ending in a hyphen straight onto the next.
 */
export function joinLineTexts(texts: readonly string[]): string {
  let out = ''
  for (const t of texts) {
    if (out === '') { out = t; continue }
    const trimmed = out.replace(/\s+$/, '')
    const next = t.replace(/^\s+/, '')
    out = trimmed.endsWith('-') ? trimmed + next : `${trimmed} ${next}`
  }
  return out
}
