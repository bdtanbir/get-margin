import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import AlignmentGuides from '@/features/overlay/AlignmentGuides.vue'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import type { PageState } from '@/stores/document'
import type { EditObject, PageQuadIndex } from '@margin/pdf-core'

const page: PageState = {
  id: 'p1', sourceId: 'src-0', sourceIndex: 0,
  geometry: { cropBox: [0, 0, 612, 792], rotate: 0 },
}

const line = (x0: number, x1: number, baseline: number) => ({
  bbox: [x0, baseline - 10, x1, baseline + 2],
  text: 'ab', font: 'Helvetica', bold: false, italic: false,
  color: [0, 0, 0], size: 10, baseline,
  chars: [{ char: 'a', quad: [x0, 0, x1, 0, x0, 0, x1, 0] }],
})

/** Two lines: rails at x 72/200/300/400 and y 100/200. */
const index = { lines: [line(72, 200, 100), line(300, 400, 200)] } as unknown as PageQuadIndex

const patch = (lineIndex: number): EditObject => ({
  id: 'tp1', pageId: 'p1', kind: 'textPatch',
  rect: { x: 72, y: 90, w: 128, h: 12 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  lineIndex, originalHash: 'h', originalText: 'ab', text: 'ab',
  fontFamily: 'Inter', fontSize: 10, baseline: 100, color: [0, 0, 0],
  background: [1, 1, 1], backgroundConfidence: 1, fit: 'overflow',
} as unknown as EditObject)

/**
 * The rails a user sees while dragging a line, and only then.
 *
 * They are feedback for a gesture in progress, not decoration -- a page
 * permanently overlaid with dashed lines is a page nobody can read.
 */
describe('AlignmentGuides', () => {
  let edits: ReturnType<typeof useEditsStore>
  let tools: ReturnType<typeof useToolsStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    tools = useToolsStore()
    edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
      { p1: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
    edits.applyOp({ type: 'addObject', object: patch(0) }, 'add')
  })

  const mountFor = () => mount(AlignmentGuides, { props: { page, index } })

  it('draws nothing when nothing is being dragged', () => {
    expect(mountFor().findAll('line')).toHaveLength(0)
  })

  it('draws a rail per coordinate once a drag starts', () => {
    tools.startMovingPatch('tp1')
    // Line 0 is the one moving, so only line 1 contributes: x 300, x 400,
    // y 200.
    expect(mountFor().findAll('line')).toHaveLength(3)
  })

  it('stops drawing when the drag ends', async () => {
    tools.startMovingPatch('tp1')
    const w = mountFor()
    tools.stopMovingPatch()
    await w.vm.$nextTick()
    expect(w.findAll('line')).toHaveLength(0)
  })

  it('spans the page, because a rail that stops short is not a rail', () => {
    tools.startMovingPatch('tp1')
    const verticals = mountFor().findAll('line').filter((l) => l.attributes('x1') === l.attributes('x2'))
    expect(verticals).toHaveLength(2)
    expect(verticals[0]!.attributes('y1')).toBe('0')
    expect(verticals[0]!.attributes('y2')).toBe('792')
  })

  it('leaves out the rails of the line being dragged', () => {
    tools.startMovingPatch('tp1')
    const xs = mountFor().findAll('line')
      .filter((l) => l.attributes('x1') === l.attributes('x2'))
      .map((l) => l.attributes('x1'))
    expect(xs).toEqual(['300', '400'])
  })

  it('draws nothing for a drag on another page', () => {
    edits.applyOp({ type: 'updateObject', id: 'tp1', patch: { pageId: 'p2' } }, 'move')
    tools.startMovingPatch('tp1')
    expect(mountFor().findAll('line')).toHaveLength(0)
  })

  /**
   * Which rail the line is actually ON, marked so the user can see what
   * the snap caught. Derived from the line's live position rather than
   * reported by the snapper: the rail highlighted is then the one the line
   * genuinely coincides with, including an alignment the user hit by hand
   * without the snap being involved.
   */
  describe('marking the rail the line is on', () => {
    const active = (w: ReturnType<typeof mountFor>) =>
      w.findAll('line').filter((l) => l.attributes('data-active') !== undefined)

    it('marks none while the line is not on a rail', () => {
      tools.startMovingPatch('tp1')
      expect(active(mountFor())).toHaveLength(0)
    })

    it('marks the vertical rail the left edge has landed on', () => {
      // The patch's left edge is x 72; +228 puts it exactly on the rail at 300.
      edits.applyOp(
        { type: 'updateObject', id: 'tp1', patch: { offset: { dx: 228, dy: 0 } } as never },
        'move',
      )
      tools.startMovingPatch('tp1')
      const marked = active(mountFor())
      expect(marked).toHaveLength(1)
      expect(marked[0]!.attributes('x1')).toBe('300')
    })

    it('marks it for the right edge too', () => {
      // Right edge 72 + 128 = 200; +200 puts it on the rail at 400.
      edits.applyOp(
        { type: 'updateObject', id: 'tp1', patch: { offset: { dx: 200, dy: 0 } } as never },
        'move',
      )
      tools.startMovingPatch('tp1')
      expect(active(mountFor())[0]!.attributes('x1')).toBe('400')
    })

    it('marks the horizontal rail the baseline has landed on', () => {
      // The patch's baseline is 100; +100 puts it on the rail at 200.
      edits.applyOp(
        { type: 'updateObject', id: 'tp1', patch: { offset: { dx: 0, dy: 100 } } as never },
        'move',
      )
      tools.startMovingPatch('tp1')
      const marked = active(mountFor())
      expect(marked).toHaveLength(1)
      expect(marked[0]!.attributes('y1')).toBe('200')
    })

    /** Float error from the snap arithmetic must not un-mark a real hit. */
    it('tolerates the rounding the snap leaves behind', () => {
      edits.applyOp(
        { type: 'updateObject', id: 'tp1', patch: { offset: { dx: 228.0000000001, dy: 0 } } as never },
        'move',
      )
      tools.startMovingPatch('tp1')
      expect(active(mountFor())).toHaveLength(1)
    })
  })

  it('draws nothing before the page’s text has been extracted', () => {
    tools.startMovingPatch('tp1')
    expect(mount(AlignmentGuides, { props: { page } }).findAll('line')).toHaveLength(0)
  })
})
