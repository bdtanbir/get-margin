import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SelectionToolbar from '@/features/tools/SelectionToolbar.vue'
import { useEditsStore } from '@/stores/edits'
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
    edits.reset('h', ['p1'], { p1: { sourceIndex: 0 } })
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
