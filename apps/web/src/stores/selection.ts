import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { PageQuadIndex, Quad } from '@margin/pdf-core'

/** A character's address within a page's quad index. */
export type CharRef = { line: number; char: number }

/**
 * Text selection state.
 *
 * Deliberately NOT in edits.ts: a selection is VIEW state. It never enters
 * edit history, never reaches the export path, and is thrown away when the
 * page unmounts. Putting it in the edit store would make every drag of the
 * cursor an undoable step.
 */
export const useSelectionStore = defineStore('textSelection', () => {
  const pageId = ref<string | undefined>(undefined)
  const index = ref<PageQuadIndex | undefined>(undefined)
  const anchor = ref<CharRef | undefined>(undefined)
  const focus = ref<CharRef | undefined>(undefined)

  /**
   * Start a selection on ONE page, binding that page's identity, its quad
   * index and the anchor in a single step.
   *
   * Atomic on purpose. Every mounted page fetches its own quad index and
   * they resolve in whatever order the worker answers, so a store that let
   * a page register an index separately from starting a selection ended up
   * holding page two's index while page one's pointer produced the refs --
   * and the highlight was painted on page two, over whatever text happened
   * to share those character positions.
   */
  function begin(page: string, quads: PageQuadIndex, ref_: CharRef): void {
    pageId.value = page
    index.value = quads
    anchor.value = ref_
    focus.value = ref_
  }

  function extend(ref_: CharRef): void {
    if (anchor.value) focus.value = ref_
  }

  function clear(): void {
    anchor.value = undefined
    focus.value = undefined
  }

  /** Anchor and focus in document order, whichever way the drag went. */
  const range = computed(() => {
    const a = anchor.value
    const f = focus.value
    if (!a || !f) return undefined
    const before = a.line < f.line || (a.line === f.line && a.char <= f.char)
    return before ? { from: a, to: f } : { from: f, to: a }
  })

  /**
   * The selected characters' quads, MERGED PER LINE into one quad each.
   *
   * One polygon per character would put a few thousand nodes in the DOM for
   * a paragraph, and adjacent per-character rectangles show hairline seams
   * where their edges meet. Merging is also what markup annotations want:
   * setQuadPoints expects one quad per contiguous run, not per glyph.
   */
  const selectedQuads = computed<Quad[]>(() => {
    const r = range.value
    const idx = index.value
    if (!r || !idx) return []
    // A click with no drag selects nothing: there is no character BETWEEN
    // an anchor and itself, and highlighting a single glyph on every stray
    // click would be noise.
    if (r.from.line === r.to.line && r.from.char === r.to.char) return []

    const out: Quad[] = []
    for (let l = r.from.line; l <= r.to.line; l++) {
      const line = idx.lines[l]
      if (!line) continue
      const start = l === r.from.line ? r.from.char : 0
      const end = l === r.to.line ? r.to.char : line.chars.length - 1
      const chars = line.chars.slice(start, end + 1)
      if (chars.length === 0) continue
      out.push(mergeQuads(chars.map((c) => c.quad)))
    }
    return out
  })

  const text = computed(() => {
    const r = range.value
    const idx = index.value
    if (!r || !idx) return ''
    const parts: string[] = []
    for (let l = r.from.line; l <= r.to.line; l++) {
      const line = idx.lines[l]
      if (!line) continue
      const start = l === r.from.line ? r.from.char : 0
      const end = l === r.to.line ? r.to.char : line.chars.length - 1
      parts.push(line.chars.slice(start, end + 1).map((c) => c.char).join(''))
    }
    return parts.join('\n')
  })

  const hasSelection = computed(() => selectedQuads.value.length > 0)

  return {
    pageId: computed(() => pageId.value),
    index: computed(() => index.value),
    range,
    selectedQuads,
    text,
    hasSelection,
    begin,
    extend,
    clear,
  }
})

/**
 * The bounding quad of a run of character quads.
 *
 * Axis-aligned, which is correct for the horizontal runs this phase
 * supports and is what MuPDF's own highlight() returns for them. A rotated
 * or skewed run would need the run's own basis rather than the page's;
 * that is a Phase 4 concern and is stated here rather than discovered later.
 *
 * Quad order is [x0,y0, x1,y1, x2,y2, x3,y3] = upper-left, upper-right,
 * lower-left, lower-right (MuPDF's fz_quad layout), and the result keeps it.
 */
export function mergeQuads(quads: Quad[]): Quad {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const q of quads) {
    for (let i = 0; i < 8; i += 2) {
      minX = Math.min(minX, q[i]!)
      maxX = Math.max(maxX, q[i]!)
      minY = Math.min(minY, q[i + 1]!)
      maxY = Math.max(maxY, q[i + 1]!)
    }
  }
  return [minX, minY, maxX, minY, minX, maxY, maxX, maxY]
}
