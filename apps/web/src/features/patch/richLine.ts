import type { Color, PatchRun, PatchSpan } from '@margin/pdf-core'
import { cssStyle, cssWeight } from '@/lib/fonts'
import { rgb } from '@/features/overlay/objects/svgPaint'
import { normalizeSpans } from './linePatch'

/**
 * The inline editor's model of one line: styled runs, every axis resolved.
 *
 * The editor used to be an <input>, which can only show one style. Typing
 * into "This letter is to confirm that **Arafat Hussain Chowdhury**..."
 * showed the name regular while you typed and stored it regular when you
 * finished. The field is now an editable element with one <span> per run,
 * and this module is the two-way bridge between those spans and the runs.
 *
 * THE DOM IS NOT RE-RENDERED AS THE USER TYPES. The browser edits the
 * spans' text in place, which is what keeps the caret where it is and
 * gives typed characters the style of the run they are typed into -- the
 * behaviour every word processor has. `readRuns` reads the result back;
 * `renderRuns` is only called when the RUNS change for another reason: the
 * field opening, or Ctrl+B over a selection.
 */
export type EditRun = PatchRun

const sameStyle = (a: EditRun, b: EditRun): boolean =>
  a.weight === b.weight && a.italic === b.italic && a.scale === b.scale &&
  a.rise === b.rise && a.color.every((v, i) => v === b.color[i])

/** Neighbours in the same style joined, empty runs dropped. */
export function mergeRuns(runs: readonly EditRun[]): EditRun[] {
  const out: EditRun[] = []
  for (const run of runs) {
    if (run.text === '') continue
    const last = out[out.length - 1]
    if (last && sameStyle(last, run)) out[out.length - 1] = { ...last, text: last.text + run.text }
    else out.push({ ...run, color: [run.color[0], run.color[1], run.color[2]] })
  }
  return out
}

export const textOf = (runs: readonly EditRun[]): string => runs.map((r) => r.text).join('')

/** The CSS one run is shown in, inside a field whose font-size is the line's size. */
function runCss(run: EditRun): Partial<CSSStyleDeclaration> {
  return {
    fontWeight: cssWeight(run.weight),
    fontStyle: cssStyle(run.italic),
    // In em of the FIELD, which is set at the line's size: a run at 0.67
    // is the superscript's 8pt on a 12pt line, at whatever zoom.
    fontSize: run.scale === 1 ? '' : `${run.scale}em`,
    // vertical-align's em is the run's OWN font size, hence the division.
    verticalAlign: run.rise === 0 ? '' : `${run.rise / run.scale}em`,
    color: rgb(run.color),
  }
}

/**
 * Replace the field's content with one <span> per run.
 *
 * Returns the styles in the order they were rendered: `readRuns` maps a
 * span back to its style by the index stored on it, rather than reading
 * the computed style, which jsdom cannot compute and a browser rounds.
 */
export function renderRuns(root: HTMLElement, runs: readonly EditRun[]): EditRun[] {
  const styles = mergeRuns(runs)
  root.replaceChildren(...styles.map((run, i) => {
    const span = document.createElement('span')
    span.dataset.run = String(i)
    Object.assign(span.style, runCss(run))
    span.textContent = run.text
    return span
  }))
  return styles
}

/** Every text node under `root`, in document order. */
function textNodes(root: Node): Text[] {
  const out: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text)
  return out
}

/**
 * The runs the field holds NOW, after whatever the browser did to it.
 *
 * A text node takes the style of the rendered span it sits in. One that
 * sits in none -- the browser's own text after the user deleted every span
 * and kept typing -- takes the style of the text before it, or of the
 * line's first run when there is none: select-all and type keeps the
 * line's leading style, which is what an <input> did too. Line breaks are
 * dropped: a patch is one line.
 */
export function readRuns(root: HTMLElement, styles: readonly EditRun[], fallback: EditRun): EditRun[] {
  const runs: EditRun[] = []
  let previous = styles[0] ?? fallback
  for (const node of textNodes(root)) {
    const owner = node.parentElement?.closest<HTMLElement>('[data-run]')
    const index = owner && root.contains(owner) ? Number(owner.dataset.run) : NaN
    const style = styles[index] ?? previous
    previous = style
    const text = (node.textContent ?? '').replace(/[\r\n]+/g, ' ')
    runs.push({ ...style, text })
  }
  return mergeRuns(runs)
}

/** Character offset of a DOM position inside `root`. */
function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  if (node.nodeType !== Node.TEXT_NODE) {
    // An element position: count the text before its `offset`th child.
    const range = document.createRange()
    range.setStart(root, 0)
    range.setEnd(node, offset)
    return range.toString().length
  }
  let total = 0
  for (const t of textNodes(root)) {
    if (t === node) return total + offset
    total += t.length
  }
  return total
}

/** The selection inside the field as [start, end) character offsets, or undefined. */
export function selectionOffsets(root: HTMLElement): [number, number] | undefined {
  const sel = root.ownerDocument.getSelection()
  if (!sel || sel.rangeCount === 0) return undefined
  const range = sel.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return undefined
  const a = offsetOf(root, range.startContainer, range.startOffset)
  const b = offsetOf(root, range.endContainer, range.endOffset)
  return a <= b ? [a, b] : [b, a]
}

/** Put the selection back at [start, end) after a re-render. */
export function selectOffsets(root: HTMLElement, start: number, end: number): void {
  const sel = root.ownerDocument.getSelection()
  if (!sel) return
  const at = (offset: number): [Node, number] => {
    let left = offset
    const nodes = textNodes(root)
    for (const t of nodes) {
      if (left <= t.length) return [t, left]
      left -= t.length
    }
    const last = nodes[nodes.length - 1]
    return last ? [last, last.length] : [root, 0]
  }
  const range = root.ownerDocument.createRange()
  range.setStart(...at(start))
  range.setEnd(...at(end))
  sel.removeAllRanges()
  sel.addRange(range)
}

/** Split runs so [start, end) is its own runs, and apply `change` to those. */
export function restyleRange(
  runs: readonly EditRun[],
  start: number,
  end: number,
  change: (run: EditRun) => Partial<EditRun>,
): EditRun[] {
  const out: EditRun[] = []
  let at = 0
  for (const run of runs) {
    const chars = [...run.text]
    const from = at
    at += chars.length
    const a = Math.max(start, from) - from
    const b = Math.min(end, at) - from
    if (b <= a) { out.push(run); continue }
    out.push({ ...run, text: chars.slice(0, a).join('') })
    out.push({ ...run, ...change(run), text: chars.slice(a, b).join('') })
    out.push({ ...run, text: chars.slice(b).join('') })
  }
  return mergeRuns(out)
}

/** The runs inside [start, end), for deciding which way a toggle goes. */
export function runsIn(runs: readonly EditRun[], start: number, end: number): EditRun[] {
  const out: EditRun[] = []
  let at = 0
  for (const run of runs) {
    const len = [...run.text].length
    if (at < end && at + len > start) out.push(run)
    at += len
  }
  return out
}

/**
 * What the runs store as: the line's own style, which is its first run's,
 * plus span overrides for every run that differs from it -- or no spans
 * at all for a line in one style.
 */
export function toPatchFields(
  runs: readonly EditRun[],
  fallback: { weight: number; italic: boolean; color: Color },
): { text: string; weight: number; italic: boolean; color: Color; spans: PatchSpan[] | undefined } {
  const merged = mergeRuns(runs)
  const base = merged[0] ?? { ...fallback, scale: 1, rise: 0, text: '' }
  const spans = normalizeSpans(merged.map((r) => {
    const span: PatchSpan = { text: r.text }
    if (r.weight !== base.weight) span.weight = r.weight
    if (r.italic !== base.italic) span.italic = r.italic
    if (r.scale !== 1) span.scale = r.scale
    if (r.rise !== 0) span.rise = r.rise
    if (!r.color.every((v, i) => v === base.color[i])) span.color = r.color
    return span
  }))
  return {
    text: textOf(merged),
    weight: base.weight,
    italic: base.italic,
    color: [base.color[0], base.color[1], base.color[2]],
    spans,
  }
}
