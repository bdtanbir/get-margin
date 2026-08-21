import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { charAt, useTextSelection } from '@/features/overlay/useTextSelection'
import { useSelectionStore, mergeQuads } from '@/stores/selection'
import type { Color, PageQuadIndex, Quad } from '@margin/pdf-core'

/**
 * Three lines of four characters, 10pt tall, stacked top-down in MuPDF page
 * space: line 0 at y 0..10, line 1 at 20..30, line 2 at 40..50. Character n
 * of each line spans x 10n..10n+10.
 */
function stubIndex(): PageQuadIndex {
  const line = (l: number, text: string) => {
    const top = l * 20
    const bottom = top + 10
    return {
      bbox: [0, top, text.length * 10, bottom] as [number, number, number, number],
      text,
      font: 'Helvetica',
      bold: false,
      italic: false,
      color: [0, 0, 0] as Color,
      size: 10,
      baseline: 116,
      chars: [...text].map((char, i) => ({
        char,
        quad: [i * 10, top, i * 10 + 10, top, i * 10, bottom, i * 10 + 10, bottom] as Quad,
      })),
    }
  }
  return { lines: [line(0, 'abcd'), line(1, 'efgh'), line(2, 'ijkl')] }
}

/** Client coords map 1:1 onto page space for these tests. */
const surface = { toPageSpace: (x: number, y: number) => ({ x, y }) }

function down(x: number, y: number): PointerEvent {
  const e = new Event('pointerdown', { bubbles: true }) as PointerEvent
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1 })
  Object.defineProperty(e, 'currentTarget', {
    value: document.createElement('div'), configurable: true,
  })
  return e
}
function move(x: number, y: number): void {
  const e = new Event('pointermove', { bubbles: true }) as PointerEvent
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1 })
  window.dispatchEvent(e)
}
function up(): void {
  window.dispatchEvent(new Event('pointerup', { bubbles: true }))
}

describe('charAt', () => {
  const index = stubIndex()

  it('finds the character under the point', () => {
    expect(charAt(index, 15, 5)).toEqual({ line: 0, char: 1 })
    expect(charAt(index, 35, 45)).toEqual({ line: 2, char: 3 })
  })

  // Without slack, a pointer in the leading between lines resolves to
  // nothing and the selection visibly stutters as the cursor crosses it.
  it('snaps to the nearest line from the gap between two lines', () => {
    expect(charAt(index, 5, 11)).toEqual({ line: 0, char: 0 })
  })

  it('snaps to the end of a line from past its right edge', () => {
    expect(charAt(index, 500, 5)).toEqual({ line: 0, char: 3 })
  })

  // Vertical distance must dominate: a point below a line belongs to the
  // line beneath it, not the far end of the one above.
  it('prefers the vertically nearer line over the horizontally nearer glyph', () => {
    expect(charAt(index, 500, 25)).toEqual({ line: 1, char: 3 })
  })

  it('returns undefined for an empty index', () => {
    expect(charAt({ lines: [] }, 0, 0)).toBeUndefined()
  })
})

describe('mergeQuads', () => {
  it('produces one bounding quad in MuPDF corner order', () => {
    expect(mergeQuads([
      [0, 0, 10, 0, 0, 10, 10, 10],
      [10, 0, 20, 0, 10, 10, 20, 10],
    ])).toEqual([0, 0, 20, 0, 0, 10, 20, 10])
  })
})

describe('useTextSelection', () => {
  let selection: ReturnType<typeof useSelectionStore>
  const index = stubIndex()

  beforeEach(() => {
    setActivePinia(createPinia())
    selection = useSelectionStore()
  })

  function drag(from: [number, number], to: [number, number], page = 'p1', idx = index): void {
    const { onPointerDown } = useTextSelection(() => page, () => idx, surface)
    onPointerDown(down(from[0], from[1]))
    move(to[0], to[1])
    up()
  }

  it('selects every character between the two anchors, including whole middle lines', () => {
    // From 'b' (line 0, char 1) to 'k' (line 2, char 2).
    drag([15, 5], [25, 45])
    expect(selection.text).toBe('bcd\nefgh\nijk')
  })

  it('selects the same range dragged right-to-left', () => {
    drag([25, 45], [15, 5])
    expect(selection.text).toBe('bcd\nefgh\nijk')
  })

  it('selects nothing for a click with no drag', () => {
    const { onPointerDown } = useTextSelection(() => 'p1', () => index, surface)
    onPointerDown(down(15, 5))
    up()
    expect(selection.selectedQuads).toEqual([])
    expect(selection.hasSelection).toBe(false)
  })

  // One polygon per character would put thousands of nodes in the DOM for a
  // paragraph and show hairline seams where their edges meet; setQuadPoints
  // wants one quad per contiguous run too.
  it('merges contiguous quads per line rather than one per character', () => {
    drag([15, 5], [25, 45])
    expect(selection.selectedQuads).toHaveLength(3)
    // Line 0 covers characters 1..3, i.e. x 10..40.
    expect(selection.selectedQuads[0]).toEqual([10, 0, 40, 0, 10, 10, 40, 10])
  })

  it('selects within a single line', () => {
    drag([5, 5], [25, 5])
    expect(selection.text).toBe('abc')
    expect(selection.selectedQuads).toHaveLength(1)
  })

  it('clear() drops the selection', () => {
    drag([15, 5], [25, 45])
    selection.clear()
    expect(selection.hasSelection).toBe(false)
    expect(selection.text).toBe('')
  })

  // A selection belongs to ONE page. Every mounted page fetches its own
  // quad index, and the fetches resolve in whatever order the worker
  // answers them -- so the page the pointer is on, not the page that
  // registered an index last, decides which index the refs address.
  it('selects on the page under the pointer, not the page whose index registered last', () => {
    const other: PageQuadIndex = { lines: [] }
    for (const l of stubIndex().lines) {
      other.lines.push({ ...l, text: l.text.toUpperCase(),
        chars: l.chars.map((c) => ({ ...c, char: c.char.toUpperCase() })) })
    }
    // Page two dragged (and so bound its own index) most recently.
    drag([15, 5], [25, 45], 'p2', other)
    drag([15, 5], [25, 45], 'p1', index)
    expect(selection.pageId).toBe('p1')
    expect(selection.text).toBe('bcd\nefgh\nijk')
  })

  // Starting a selection on another page must not leave the old page's
  // character refs pointing into the new page's index.
  it('drops the previous page selection when a new page begins one', () => {
    drag([15, 5], [25, 45])
    drag([5, 5], [5, 5], 'p2', stubIndex())
    expect(selection.pageId).toBe('p2')
    expect(selection.hasSelection).toBe(false)
  })
})
