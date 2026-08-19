import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SelectionToolbar from '@/features/tools/SelectionToolbar.vue'
import { useEditsStore } from '@/stores/edits'
import { useSelectionStore } from '@/stores/selection'
import type { PageState } from '@/stores/document'
import type { EditObject } from '@margin/pdf-core'

const page: PageState = { id: 'p1', sourceIndex: 0, geometry: { cropBox: [0, 0, 612, 792], rotate: 0 } }

function obj(id: string, z = 1): EditObject {
  return {
    id, pageId: 'p1', kind: 'rect',
    rect: { x: 100, y: 200, w: 80, h: 40 },
    rotation: 0, z, locked: false, opacity: 1,
    stroke: [0, 0, 0], strokeWidth: 1, fill: null,
  }
}

describe('SelectionToolbar', () => {
  let edits: ReturnType<typeof useEditsStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'], { p1: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
    edits.applyOp({ type: 'addObject', object: obj('o1') }, 'add')
    edits.applyOp({ type: 'addObject', object: obj('o2', 5) }, 'add')
  })

  const mountFor = () => mount(SelectionToolbar, { props: { page, zoom: 1 } })

  it('renders nothing with no selection', () => {
    expect(mountFor().find('button').exists()).toBe(false)
  })

  it('deletes the selected object and clears the selection', async () => {
    edits.select(['o1'])
    await mountFor().get('[aria-label="Delete"]').trigger('click')
    expect(edits.doc.objects.o1).toBeUndefined()
    expect(edits.selection).toEqual([])
  })

  it('duplicates onto a fresh id, offset, and selects the copy', async () => {
    edits.select(['o1'])
    await mountFor().get('[aria-label="Duplicate"]').trigger('click')
    const ids = Object.keys(edits.doc.objects)
    expect(ids).toHaveLength(3)
    const copyId = edits.selection[0]!
    expect(copyId).not.toBe('o1')
    // Offset so the copy is visibly not the original sitting underneath.
    expect(edits.doc.objects[copyId]?.rect.x).not.toBe(100)
  })

  it('brings to front above every other object on the page', async () => {
    edits.select(['o1'])
    await mountFor().get('[aria-label="Bring to front"]').trigger('click')
    expect(edits.doc.objects.o1!.z).toBeGreaterThan(edits.doc.objects.o2!.z)
  })

  it('sends to back below every other object on the page', async () => {
    edits.select(['o2'])
    await mountFor().get('[aria-label="Send to back"]').trigger('click')
    expect(edits.doc.objects.o2!.z).toBeLessThan(edits.doc.objects.o1!.z)
  })

  it('locks and unlocks', async () => {
    edits.select(['o1'])
    const w = mountFor()
    await w.get('[aria-label="Lock"]').trigger('click')
    expect(edits.doc.objects.o1?.locked).toBe(true)
    await w.get('[aria-label="Unlock"]').trigger('click')
    expect(edits.doc.objects.o1?.locked).toBe(false)
  })

  // A locked object can still be unlocked, deleted, or reordered -- lock
  // guards dragging, not the toolbar itself. Anything else is a trap.
  it('keeps its controls usable on a locked object', async () => {
    edits.applyOp({ type: 'updateObject', id: 'o1', patch: { locked: true } }, 'lock')
    edits.select(['o1'])
    const w = mountFor()
    for (const b of w.findAll('button')) expect(b.attributes('disabled')).toBeUndefined()
  })

  it('every action is one undo step', async () => {
    edits.select(['o1'])
    const before = edits.historySize
    await mountFor().get('[aria-label="Bring to front"]').trigger('click')
    expect(edits.historySize).toBe(before + 1)
  })
})

// Task 38: turning a TEXT selection into a native markup annotation.
describe('SelectionToolbar markup actions', () => {
  let edits: ReturnType<typeof useEditsStore>
  let selection: ReturnType<typeof useSelectionStore>

  /** Two characters on one line, in MuPDF page space (top-down). */
  const index = {
    lines: [{
      bbox: [10, 100, 30, 120] as [number, number, number, number],
      text: 'ab', font: 'Helvetica', size: 10,
      chars: [
        { char: 'a', quad: [10, 100, 20, 100, 10, 120, 20, 120] as never },
        { char: 'b', quad: [20, 100, 30, 100, 20, 120, 30, 120] as never },
      ],
    }],
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    selection = useSelectionStore()
    edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'], { p1: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
    selection.setIndex('p1', index)
  })

  const mountFor = () => mount(SelectionToolbar, { props: { page, zoom: 1 } })

  function selectText(): void {
    selection.begin({ line: 0, char: 0 })
    selection.extend({ line: 0, char: 1 })
  }

  it('shows no markup toolbar without a text selection', () => {
    expect(mountFor().find('[data-markup-toolbar]').exists()).toBe(false)
  })

  it('shows the three markup actions when text is selected', () => {
    selectText()
    const w = mountFor()
    expect(w.find('[data-markup-toolbar]').exists()).toBe(true)
    for (const label of ['Highlight', 'Underline', 'Strikeout']) {
      expect(w.find(`[aria-label="${label}"]`).exists()).toBe(true)
    }
  })

  it.each(['Highlight', 'Underline', 'Strikeout'] as const)(
    'creates a %s object from the selected quads',
    async (label) => {
      selectText()
      await mountFor().get(`[aria-label="${label}"]`).trigger('click')
      const object = Object.values(edits.doc.objects)[0]!
      expect(object.kind).toBe(label.toLowerCase())
      expect((object as { quads: number[][] }).quads).toEqual([[10, 100, 30, 100, 10, 120, 30, 120]])
    },
  )

  // Quads stay in MuPDF page space; the object's rect is raw bottom-up PDF
  // space like every other object. Two spaces in one object is deliberate.
  it('stores the rect in bottom-up PDF space while the quads stay top-down', async () => {
    selectText()
    await mountFor().get('[aria-label="Highlight"]').trigger('click')
    const object = Object.values(edits.doc.objects)[0]!
    // Quads span y 100..120 top-down on a 792pt page -> rect bottom at 672.
    expect(object.rect).toEqual({ x: 10, y: 672, w: 20, h: 20 })
  })

  it('clears the text selection and selects the new object', async () => {
    selectText()
    await mountFor().get('[aria-label="Highlight"]').trigger('click')
    expect(selection.hasSelection).toBe(false)
    expect(edits.selection).toEqual([Object.keys(edits.doc.objects)[0]])
  })

  it('is one undo step', async () => {
    selectText()
    const before = edits.historySize
    await mountFor().get('[aria-label="Highlight"]').trigger('click')
    expect(edits.historySize).toBe(before + 1)
  })
})
