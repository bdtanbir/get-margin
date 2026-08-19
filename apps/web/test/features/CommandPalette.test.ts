import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import CommandPalette from '@/features/command/CommandPalette.vue'
import { useCommands, filterCommands } from '@/features/command/commands'
import { TOOLS } from '@/features/tools/toolList'
import { useToolsStore } from '@/stores/tools'
import { useEditsStore } from '@/stores/edits'
import { usePageSelectionStore } from '@/stores/pageSelection'
import { seedPages } from '../helpers/seedDocument'

/**
 * A real key press, as useMagicKeys observes one.
 *
 * The modifier arrives as its own keydown (useMagicKeys derives combos from
 * the set of keys currently down, not from `ctrlKey`), and a tick separates
 * the down from the up -- `whenever` is a watcher, so a press released in
 * the same tick leaves the ref back at false before it ever runs.
 */
async function press(key: string, mods: { ctrl?: boolean } = {}): Promise<void> {
  const init = { bubbles: true, ctrlKey: !!mods.ctrl }
  if (mods.ctrl) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ...init }))
  window.dispatchEvent(new KeyboardEvent('keydown', { key, ...init }))
  await nextTick()
  window.dispatchEvent(new KeyboardEvent('keyup', { key, ...init }))
  if (mods.ctrl) window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', ...init }))
  await nextTick()
}

async function openPalette(w: ReturnType<typeof mount>) {
  await press('k', { ctrl: true })
  await nextTick()
  return w
}

describe('commands registry', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    seedPages(3)
  })

  // Two hand-maintained lists of the same tools is how a palette silently
  // falls behind the rail.
  it('offers every tool from the rail', () => {
    const ids = useCommands().value.map((c) => c.id)
    for (const tool of TOOLS) expect(ids).toContain(`tool:${tool.id}`)
  })

  it('hides page commands until pages are selected', () => {
    const before = useCommands().value.filter((c) => c.available()).map((c) => c.id)
    expect(before).not.toContain('page:delete')

    usePageSelectionStore().selectOnly('p0')
    const after = useCommands().value.filter((c) => c.available()).map((c) => c.id)
    expect(after).toContain('page:delete')
  })

  it('hides undo until there is something to undo', () => {
    const edits = useEditsStore()
    expect(useCommands().value.find((c) => c.id === 'doc:undo')!.available()).toBe(false)
    edits.applyOp({ type: 'rotatePage', pageId: 'p0', by: 90 }, 'Rotate')
    expect(useCommands().value.find((c) => c.id === 'doc:undo')!.available()).toBe(true)
  })
})

describe('filterCommands', () => {
  const commands = [
    { id: 'a', label: 'Rotate selected pages right', group: 'g', run: () => {}, available: () => true },
    { id: 'b', label: 'Redo', group: 'g', run: () => {}, available: () => true },
    { id: 'c', label: 'Signature', group: 'g', run: () => {}, available: () => true },
  ]

  it('returns everything for an empty query', () => {
    expect(filterCommands(commands, '  ')).toHaveLength(3)
  })

  it('matches a substring, case-insensitively', () => {
    expect(filterCommands(commands, 'redo').map((c) => c.id)).toEqual(['b'])
  })

  // "rsp" should find "Rotate selected pages".
  it('matches a subsequence', () => {
    expect(filterCommands(commands, 'rsp').map((c) => c.id)).toContain('a')
  })

  // When someone types a whole word they mean that word.
  it('ranks a substring hit above a subsequence one', () => {
    const out = filterCommands(commands, 'sig')
    expect(out[0]!.id).toBe('c')
  })

  it('returns nothing when nothing matches', () => {
    expect(filterCommands(commands, 'zzzz')).toEqual([])
  })
})

describe('CommandPalette', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    seedPages(3)
  })

  it('is closed until asked for', () => {
    expect(mount(CommandPalette).find('[data-command-palette]').exists()).toBe(false)
  })

  it('opens on Ctrl+K', async () => {
    const w = await openPalette(mount(CommandPalette, { attachTo: document.body }))
    expect(w.find('[data-command-palette]').exists()).toBe(true)
  })

  it('filters as you type', async () => {
    const w = await openPalette(mount(CommandPalette, { attachTo: document.body }))
    await w.get('[data-command-input]').setValue('whiteout')
    const shown = w.findAll('[data-command]').map((el) => el.attributes('data-command'))
    expect(shown).toEqual(['tool:whiteout'])
  })

  it('runs the highlighted command on Enter', async () => {
    const w = await openPalette(mount(CommandPalette, { attachTo: document.body }))
    await w.get('[data-command-input]').setValue('whiteout')
    await w.get('[data-command-input]').trigger('keydown', { key: 'Enter' })
    expect(useToolsStore().active).toBe('whiteout')
  })

  it('runs a clicked command', async () => {
    const w = await openPalette(mount(CommandPalette, { attachTo: document.body }))
    await w.get('[data-command-input]').setValue('ellipse')
    await w.get('[data-command="tool:ellipse"]').trigger('click')
    expect(useToolsStore().active).toBe('ellipse')
  })

  it('closes after running something', async () => {
    const w = await openPalette(mount(CommandPalette, { attachTo: document.body }))
    await w.get('[data-command-input]').setValue('ellipse')
    await w.get('[data-command="tool:ellipse"]').trigger('click')
    await nextTick()
    expect(w.find('[data-command-palette]').exists()).toBe(false)
  })

  it('closes on Escape', async () => {
    const w = await openPalette(mount(CommandPalette, { attachTo: document.body }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(w.find('[data-command-palette]').exists()).toBe(false)
  })

  it('moves the highlight with the arrow keys', async () => {
    const w = await openPalette(mount(CommandPalette, { attachTo: document.body }))
    const first = w.get('[aria-selected="true"]').attributes('data-command')
    await w.get('[data-command-input]').trigger('keydown', { key: 'ArrowDown' })
    expect(w.get('[aria-selected="true"]').attributes('data-command')).not.toBe(first)
  })

  // A filtered list can be shorter than the highlight; without the reset,
  // Enter after typing runs nothing at all.
  it('keeps the highlight inside the filtered list', async () => {
    const w = await openPalette(mount(CommandPalette, { attachTo: document.body }))
    for (let i = 0; i < 6; i++) {
      await w.get('[data-command-input]').trigger('keydown', { key: 'ArrowDown' })
    }
    await w.get('[data-command-input]').setValue('whiteout')
    expect(w.findAll('[aria-selected="true"]')).toHaveLength(1)
  })

  it('says so when nothing matches', async () => {
    const w = await openPalette(mount(CommandPalette, { attachTo: document.body }))
    await w.get('[data-command-input]').setValue('zzzzzz')
    expect(w.text()).toContain('Nothing matches')
  })
})
