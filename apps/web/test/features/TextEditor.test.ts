import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import TextEditor from '@/features/overlay/TextEditor.vue'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import type { PageState } from '@/stores/document'
import type { EditObject } from '@margin/pdf-core'

const page: PageState = { id: 'p1', sourceId: 'src-0', sourceIndex: 0, geometry: { cropBox: [0, 0, 612, 792], rotate: 0 } }

const textObject: EditObject = {
  id: 't1', pageId: 'p1', kind: 'text', text: 'hello',
  rect: { x: 100, y: 600, w: 200, h: 24 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  fontFamily: 'Inter', fontSize: 14, color: [0, 0, 0], align: 'left',
}

describe('TextEditor', () => {
  let edits: ReturnType<typeof useEditsStore>
  let tools: ReturnType<typeof useToolsStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    edits = useEditsStore()
    tools = useToolsStore()
    edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'], { p1: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
    edits.applyOp({ type: 'addObject', object: textObject }, 'add')
  })

  const mountEditor = () => mount(TextEditor, { props: { page, zoom: 1 }, attachTo: document.body })

  /**
   * Same iOS problem the patch editor had: Safari zooms the whole page when
   * it focuses a field drawing under 16px, and a 14pt text object at zoom 1
   * is 14px. Tapping your own text box to fix a typo threw the viewport to
   * a random magnification.
   */
  it('gives iOS no reason to zoom, without drawing the text any larger', async () => {
    tools.startEditing('t1')
    const w = mountEditor()
    await w.vm.$nextTick()

    const style = (w.get('[data-text-editor]').element as HTMLElement).style
    const declared = Number.parseFloat(style.fontSize)
    const scale = Number(/scale\(([\d.]+)\)/.exec(style.transform)?.[1] ?? 1)

    expect(declared).toBeGreaterThanOrEqual(16)
    expect(declared * scale, 'the text must still draw at its own 14px').toBeCloseTo(14, 6)
    expect(style.transformOrigin).toBe('top left')
  })

  async function type(w: ReturnType<typeof mountEditor>, text: string): Promise<void> {
    const node = w.get('[data-text-editor]').element as HTMLElement
    node.innerText = text
    await w.get('[data-text-editor]').trigger('input')
  }

  it('renders nothing until an object is being edited', () => {
    expect(mountEditor().find('[data-text-editor]').exists()).toBe(false)
  })

  it('opens on the object the tools store says is being edited', async () => {
    tools.startEditing('t1')
    const w = mountEditor()
    await vi.runAllTimersAsync()
    expect(w.find('[data-text-editor]').exists()).toBe(true)
  })

  it('positions itself in view space, accounting for the y-flip', async () => {
    tools.startEditing('t1')
    const w = mountEditor()
    await vi.runAllTimersAsync()
    const box = w.get('[data-text-editor]').element as HTMLElement
    // PDF y 600..624 on a 792pt page -> view top = 792-624 = 168.
    expect(box.style.left).toBe('100px')
    expect(box.style.top).toBe('168px')
    // The DRAWN width, not the declared one. The element is over-sized and
    // scaled back down so iOS has no reason to zoom the page while it is
    // focused (lib/textFieldZoom.ts); left/top are untouched by that,
    // because the transform runs from the top-left corner.
    const scale = Number(/scale\(([\d.]+)\)/.exec(box.style.transform)?.[1] ?? 1)
    expect(Number.parseFloat(box.style.width) * scale).toBeCloseTo(200, 6)
  })

  it('scales its type size with zoom so the caret matches the export', async () => {
    tools.startEditing('t1')
    const w = mount(TextEditor, { props: { page, zoom: 2 }, attachTo: document.body })
    await vi.runAllTimersAsync()
    const box = w.get('[data-text-editor]').element as HTMLElement
    expect(box.style.fontSize).toBe('28px')
  })

  it('writes typed text through applyOp', async () => {
    tools.startEditing('t1')
    const w = mountEditor()
    await vi.runAllTimersAsync()
    await type(w, 'hello world')
    expect(edits.doc.objects.t1).toMatchObject({ text: 'hello world' })
  })

  // Typing is one undo step, not one per keystroke.
  it('coalesces a burst of typing into one history entry', async () => {
    tools.startEditing('t1')
    const w = mountEditor()
    await vi.runAllTimersAsync()
    const before = edits.historySize
    for (const s of ['h', 'he', 'hel', 'hell', 'hello!']) await type(w, s)
    expect(edits.historySize).toBe(before)
    await vi.advanceTimersByTimeAsync(500)
    expect(edits.historySize).toBe(before + 1)
    edits.undo()
    expect(edits.doc.objects.t1).toMatchObject({ text: 'hello' })
  })

  it('starts a new entry after an idle pause', async () => {
    tools.startEditing('t1')
    const w = mountEditor()
    await vi.runAllTimersAsync()
    const before = edits.historySize
    await type(w, 'one')
    await vi.advanceTimersByTimeAsync(500)
    await type(w, 'two')
    await vi.advanceTimersByTimeAsync(500)
    expect(edits.historySize).toBe(before + 2)
  })

  it('commits immediately on blur and closes the editor', async () => {
    tools.startEditing('t1')
    const w = mountEditor()
    await vi.runAllTimersAsync()
    const before = edits.historySize
    await type(w, 'typed')
    await w.get('[data-text-editor]').trigger('blur')
    expect(edits.historySize).toBe(before + 1)
    expect(tools.editingId).toBeUndefined()
  })

  // An unmount mid-type must not leave the store's transaction depth above
  // zero -- the next gesture's history would be swallowed into it.
  it('closes its transaction when unmounted mid-type', async () => {
    tools.startEditing('t1')
    const w = mountEditor()
    await vi.runAllTimersAsync()
    await type(w, 'partial')
    w.unmount()
    const before = edits.historySize
    edits.applyOp({ type: 'updateObject', id: 't1', patch: { opacity: 0.5 } }, 'Later')
    expect(edits.historySize).toBe(before + 1)
  })

  it('ignores an object on a different page', async () => {
    edits.applyOp({
      type: 'addObject',
      object: { ...textObject, id: 't2', pageId: 'p9' } as EditObject,
    }, 'add')
    tools.startEditing('t2')
    const w = mountEditor()
    await vi.runAllTimersAsync()
    expect(w.find('[data-text-editor]').exists()).toBe(false)
  })
})
