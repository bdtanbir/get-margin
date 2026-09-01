import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { defineComponent, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useEditShortcuts } from '@/features/tools/useEditShortcuts'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { useDocumentStore } from '@/stores/document'
import { useDialogsStore } from '@/stores/dialogs'
import type { EditObject } from '@margin/pdf-core'
import type { PageGeometry } from '@margin/transform'

const Host = defineComponent({
  setup: () => { useEditShortcuts(); return () => null },
})

function rect(id = 'o1', locked = false): EditObject {
  return {
    id, pageId: 'p0', kind: 'rect',
    rect: { x: 0, y: 0, w: 10, h: 10 },
    rotation: 0, z: 1, locked, opacity: 1,
    stroke: [0, 0, 0], strokeWidth: 1, fill: null,
  }
}

/**
 * A real key press, as useMagicKeys observes one.
 *
 * Two details it depends on. First, useMagicKeys derives combo state from
 * the SET of keys currently down, so a modifier has to arrive as its own
 * keydown ('Control'), not merely as `ctrlKey: true` on the letter's event.
 * Second, `whenever` is a watcher: a keydown and keyup dispatched in the
 * same tick leave the ref back at false before the watcher ever runs, so
 * the tick between them is load-bearing rather than cosmetic.
 */
async function press(
  key: string,
  mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {},
  target?: EventTarget,
): Promise<void> {
  const t = target ?? window
  const down: string[] = []
  if (mods.ctrl) down.push('Control')
  if (mods.meta) down.push('Meta')
  if (mods.shift) down.push('Shift')

  const init = { ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift }
  for (const m of down) {
    t.dispatchEvent(new KeyboardEvent('keydown', { key: m, bubbles: true, ...init }))
  }
  t.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
  await nextTick()
  t.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, ...init }))
  for (const m of down) {
    t.dispatchEvent(new KeyboardEvent('keyup', { key: m, bubbles: true, ...init }))
  }
  await nextTick()
}

describe('useEditShortcuts', () => {
  let edits: ReturnType<typeof useEditsStore>
  let tools: ReturnType<typeof useToolsStore>
  let host: ReturnType<typeof mount>

  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    tools = useToolsStore()
    edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p0'], { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
    host = mount(Host, { attachTo: document.body })
  })

  afterEach(() => host.unmount())

  it('undoes with Ctrl+Z', async () => {
    edits.applyOp({ type: 'addObject', object: rect() }, 'Draw')
    await press('z', { ctrl: true })
    expect(Object.keys(edits.doc.objects)).toHaveLength(0)
  })

  it('redoes with Ctrl+Shift+Z', async () => {
    edits.applyOp({ type: 'addObject', object: rect() }, 'Draw')
    edits.undo()
    await press('z', { ctrl: true, shift: true })
    expect(Object.keys(edits.doc.objects)).toEqual(['o1'])
  })

  it('redoes with Ctrl+Y, the Windows convention', async () => {
    edits.applyOp({ type: 'addObject', object: rect() }, 'Draw')
    edits.undo()
    await press('y', { ctrl: true })
    expect(Object.keys(edits.doc.objects)).toEqual(['o1'])
  })

  it('deletes the selected object with Backspace', async () => {
    edits.applyOp({ type: 'addObject', object: rect() }, 'Draw')
    edits.select(['o1'])
    await press('Backspace')
    expect(Object.keys(edits.doc.objects)).toHaveLength(0)
    expect(edits.selection).toEqual([])
  })

  // Unlocking is a deliberate act; Backspace is not.
  it('refuses to delete a locked object', async () => {
    edits.applyOp({ type: 'addObject', object: rect('o1', true) }, 'Draw')
    edits.select(['o1'])
    await press('Delete')
    expect(Object.keys(edits.doc.objects)).toEqual(['o1'])
  })

  it('returns to the select tool on Escape', async () => {
    tools.setTool('rect')
    await press('Escape')
    expect(tools.active).toBe('select')
  })

  // Inside a text editor the browser's own text-level undo is what the user
  // expects; hijacking Cmd+Z there would rewind the whole document instead
  // of the last few characters.
  it('does not undo the document while typing in a contenteditable', async () => {
    edits.applyOp({ type: 'addObject', object: rect() }, 'Draw')
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.appendChild(editable)
    editable.focus()
    await press('z', { ctrl: true }, editable)
    expect(Object.keys(edits.doc.objects)).toEqual(['o1'])
    editable.remove()
  })

  it('does not undo the document while typing in an input', async () => {
    edits.applyOp({ type: 'addObject', object: rect() }, 'Draw')
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    await press('z', { ctrl: true }, input)
    expect(Object.keys(edits.doc.objects)).toEqual(['o1'])
    input.remove()
  })

  it('stops listening once the host unmounts', async () => {
    edits.applyOp({ type: 'addObject', object: rect() }, 'Draw')
    host.unmount()
    await press('z', { ctrl: true })
    expect(Object.keys(edits.doc.objects)).toEqual(['o1'])
  })
})

/**
 * Nudging what is selected with the arrow keys.
 *
 * The gesture people reach for when the mouse is not precise enough: a
 * signature that has to line up with a printed rule, a logo a point off
 * centre. Until this, the only way to move anything was to drag it.
 */
describe('arrow keys', () => {
  let edits: ReturnType<typeof useEditsStore>
  let host: ReturnType<typeof mount>

  /** A page the document store can resolve geometry for. */
  const GEOMETRY: PageGeometry = { cropBox: [0, 0, 612, 792], rotate: 0 }

  function seed(o: EditObject = rect()): void {
    edits.applyOp({ type: 'addObject', object: o }, 'Draw')
    edits.select([o.id])
  }

  const moved = (): { x: number; y: number } => {
    const o = edits.doc.objects.o1!
    return { x: o.rect.x, y: o.rect.y }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p0'],
      { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
    useDocumentStore().$patch({
      status: 'ready',
      fileName: 'a.pdf',
      sources: { 'src-0': { id: 'src-0', name: 'a.pdf', pageCount: 1, geometries: [GEOMETRY] } },
    })
    host = mount(Host, { attachTo: document.body })
  })

  afterEach(() => host.unmount())

  it('moves the selection one point per press', async () => {
    seed()
    await press('ArrowRight')
    expect(moved().x).toBe(1)
  })

  it('moves it up the page for an up arrow', async () => {
    seed()
    await press('ArrowUp')
    // A PDF counts y from the bottom, so up the SCREEN is up the number.
    expect(moved().y).toBe(1)
  })

  it('moves it down and left for the other two', async () => {
    seed()
    await press('ArrowDown')
    await press('ArrowLeft')
    expect(moved()).toEqual({ x: -1, y: -1 })
  })

  it('moves ten points at a time with Shift held', async () => {
    seed()
    await press('ArrowRight', { shift: true })
    expect(moved().x).toBe(10)
  })

  /**
   * The trap the undo/redo bindings already carry a comment about:
   * useMagicKeys reports `ArrowRight` as true during `Shift+ArrowRight`
   * too, so an unguarded plain binding fires alongside the shifted one and
   * the object moves eleven points instead of ten.
   */
  it('does not add a plain step to a shifted one', async () => {
    seed()
    await press('ArrowRight', { shift: true })
    expect(moved().x).not.toBe(11)
  })

  it('collapses a run of presses into one undo step', async () => {
    seed()
    await press('ArrowRight')
    await press('ArrowRight')
    await press('ArrowRight')
    expect(moved().x).toBe(3)
    edits.undo()
    // One undo puts the object back where the run started, rather than
    // needing one press-worth of undo each.
    expect(moved().x).toBe(0)
  })

  it('leaves a locked object where it is', async () => {
    seed(rect('o1', true))
    await press('ArrowRight')
    expect(moved().x).toBe(0)
  })

  it('moves nothing when nothing is selected', async () => {
    edits.applyOp({ type: 'addObject', object: rect() }, 'Draw')
    await press('ArrowRight')
    expect(moved().x).toBe(0)
  })

  /** Arrows belong to the caret while there is one. */
  it('leaves the selection alone while the user is typing', async () => {
    seed()
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    await press('ArrowRight', {}, input)
    expect(moved().x).toBe(0)
    input.remove()
  })

  /**
   * The pages grid binds its own arrows to move between pages, and it lives
   * in a dialog. Nudging the canvas underneath it at the same time would
   * move something the user cannot even see.
   */
  it('leaves the selection alone while a dialog is open', async () => {
    seed()
    useDialogsStore().show('find')
    await press('ArrowRight')
    expect(moved().x).toBe(0)
  })
})
