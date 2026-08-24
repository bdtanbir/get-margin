import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import InspectorSheet from '@/features/tools/InspectorSheet.vue'
import { useEditsStore } from '@/stores/edits'
import { seedPages } from '../helpers/seedDocument'

const SHEET = '[data-inspector-sheet]'

function selectARectangle(): string {
  const edits = useEditsStore()
  const id = 'o1'
  edits.applyOp(
    {
      type: 'addObject',
      object: {
        id, pageId: 'p0', kind: 'rect',
        rect: { x: 10, y: 10, w: 50, h: 40 },
        rotation: 0, z: 1, locked: false, opacity: 1,
        stroke: [0, 0, 0], strokeWidth: 2, fill: null,
      },
    },
    'Draw',
  )
  edits.select([id])
  return id
}

describe('InspectorSheet', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    seedPages(1)
  })

  /**
   * The whole point of the change. Drawing an object selects it, and a
   * sheet that opened on selection alone slid up over the document every
   * single time -- after every shape, and again the moment a finger
   * touched one to move it.
   */
  it('stays shut when something is selected but nobody asked for it', () => {
    selectARectangle()

    const w = mount(InspectorSheet, { props: { open: false } })

    expect(w.find(SHEET).exists()).toBe(false)
  })

  it('opens when asked, with a selection to describe', () => {
    selectARectangle()

    const w = mount(InspectorSheet, { props: { open: true } })

    expect(w.find(SHEET).exists()).toBe(true)
  })

  it('has nothing to show without a selection, however it was asked', () => {
    const w = mount(InspectorSheet, { props: { open: true } })

    expect(w.find(SHEET).exists()).toBe(false)
  })

  /**
   * Load-bearing. Without it the parent's flag stays true after the
   * selection goes away, and the sheet springs open again by itself on the
   * next object drawn -- which is the behaviour being removed.
   */
  it('asks to be closed when the selection goes away', async () => {
    selectARectangle()
    const w = mount(InspectorSheet, { props: { open: true } })

    useEditsStore().clearSelection()
    await w.vm.$nextTick()

    expect(w.emitted('close')).toBeTruthy()
    expect(w.find(SHEET).exists()).toBe(false)
  })

  /**
   * Done dismisses the PANEL, not the selection. The object stays selected
   * so it can still be dragged, nudged or deleted; clearing a selection is
   * what tapping empty page is for.
   */
  it('keeps the object selected when dismissed', async () => {
    const id = selectARectangle()
    const w = mount(InspectorSheet, { props: { open: true } })

    await w.get('[data-inspector-done]').trigger('click')

    expect(w.emitted('close')).toBeTruthy()
    expect(useEditsStore().selection).toEqual([id])
  })
})
