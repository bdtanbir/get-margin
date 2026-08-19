import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { defineComponent, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useEditShortcuts } from '@/features/tools/useEditShortcuts'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import type { EditObject } from '@margin/pdf-core'

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
    edits.reset('h', ['p0'], { p0: { sourceIndex: 0 } })
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
