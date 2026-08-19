import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import Inspector from '@/features/tools/Inspector.vue'
import { useEditsStore } from '@/stores/edits'
import type { EditObject } from '@margin/pdf-core'

const rect: EditObject = {
  id: 'o1', pageId: 'p1', kind: 'rect',
  rect: { x: 10, y: 20, w: 100, h: 50 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  stroke: [0, 0, 0], strokeWidth: 2, fill: null,
}

describe('Inspector', () => {
  let edits: ReturnType<typeof useEditsStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    edits.reset('h', ['p1'], { p1: { sourceIndex: 0 } })
    edits.applyOp({ type: 'addObject', object: rect }, 'add')
  })

  it('prompts to select something when nothing is selected', () => {
    expect(mount(Inspector).text()).toContain('Select an object')
  })

  it('shows the fields for the selected kind', () => {
    edits.select(['o1'])
    const w = mount(Inspector)
    expect(w.find('[data-field="strokeWidth"]').exists()).toBe(true)
    expect(w.find('[data-field="opacity"]').exists()).toBe(true)
    expect(w.find('[data-field="fontSize"]').exists()).toBe(false)
  })

  it('writes changes through applyOp, so they are undoable', async () => {
    edits.select(['o1'])
    const w = mount(Inspector)
    await w.get('[data-field="opacity"] input').setValue('0.5')
    expect(edits.doc.objects.o1?.opacity).toBe(0.5)
    edits.undo()
    expect(edits.doc.objects.o1?.opacity).toBe(1)
  })

  // NOT wrapper.setValue(): VTU fires `input` AND `change` on every call, so
  // it cannot express a slider still being held -- the exact state this
  // behaviour exists for. A browser fires `input` per pixel of travel and
  // one `change` on release, which is what these helpers reproduce.
  // `w.get()` returns Omit<DOMWrapper, 'exists'>, not DOMWrapper, so the
  // parameter is typed structurally against what this actually uses.
  type Draggable = { element: Element; trigger: (event: string) => Promise<void> }

  const drag = async (input: Draggable, v: string): Promise<void> => {
    ;(input.element as HTMLInputElement).value = v
    await input.trigger('input')
  }

  it('coalesces a slider drag into one history entry', async () => {
    edits.select(['o1'])
    const w = mount(Inspector)
    const input = w.get('[data-field="opacity"] input')
    const before = edits.historySize
    for (const v of ['0.9', '0.8', '0.7', '0.6']) await drag(input, v)
    // Still held: nothing committed yet, and the value is already live.
    expect(edits.historySize).toBe(before)
    expect(edits.doc.objects.o1?.opacity).toBe(0.6)
    await input.trigger('change')
    expect(edits.historySize).toBe(before + 1)
  })

  it('disables every field on a locked object', async () => {
    edits.applyOp({ type: 'updateObject', id: 'o1', patch: { locked: true } }, 'lock')
    edits.select(['o1'])
    const w = mount(Inspector)
    for (const i of w.findAll('input')) expect(i.attributes('disabled')).toBeDefined()
  })

  it('writes a colour field back as MuPDF 0..1 channels, not a hex string', async () => {
    edits.select(['o1'])
    const w = mount(Inspector)
    await w.get('[data-field="stroke"] input').setValue('#ff0000')
    expect(edits.doc.objects.o1).toMatchObject({ stroke: [1, 0, 0] })
  })

  it('parses numeric fields as numbers, not the input element strings', async () => {
    edits.select(['o1'])
    const w = mount(Inspector)
    await w.get('[data-field="strokeWidth"] input').setValue('3.5')
    expect(edits.doc.objects.o1).toMatchObject({ strokeWidth: 3.5 })
  })

  // A second, separate drag is a second undo step -- coalescing must reset
  // when the gesture ends, not swallow everything after the first one.
  it('starts a new history entry for a second drag', async () => {
    edits.select(['o1'])
    const w = mount(Inspector)
    const input = w.get('[data-field="opacity"] input')
    const before = edits.historySize
    await drag(input, '0.9')
    await input.trigger('change')
    await drag(input, '0.4')
    await input.trigger('change')
    expect(edits.historySize).toBe(before + 2)
  })
})
