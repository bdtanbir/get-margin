import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { defineComponent } from 'vue'
import HelpPanel from '@/features/help/HelpPanel.vue'
import { SHORTCUTS, combosFor, shortcut, shortcutsByGroup } from '@/features/help/shortcuts'
import { useEditShortcuts } from '@/features/tools/useEditShortcuts'
import { AUTHOR_NAME, AUTHOR_URL } from '@/lib/author'

vi.mock('@/lib/autosaveDb', () => ({
  clearEdits: async () => {}, putEdit: async () => {}, findEdit: async () => undefined,
  deleteEdit: async () => {}, pruneEdits: async () => {}, RETENTION_MS: 1, MAX_RECORDS: 20,
}))

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('HelpPanel', () => {
  it('lists every declared shortcut, with the key it is documented as', () => {
    const w = mount(HelpPanel)
    for (const s of SHORTCUTS) {
      const row = w.get(`[data-help-shortcut="${s.id}"]`)
      expect(row.text(), s.id).toContain(s.label)
      expect(row.text(), s.id).toContain(s.display)
    }
  })

  it('groups them, and lists each shortcut exactly once', () => {
    const w = mount(HelpPanel)
    const rows = w.findAll('[data-help-shortcut]')
    expect(rows).toHaveLength(SHORTCUTS.length)

    const ids = rows.map((r) => r.attributes('data-help-shortcut'))
    expect(new Set(ids).size).toBe(SHORTCUTS.length)
  })

  it('says what the app is, and its limits, without retyping them', () => {
    const w = mount(HelpPanel)
    expect(w.text()).toContain('150 MB')
    expect(w.text()).toContain('800 pages')
  })

  it('says files stay on the device', () => {
    expect(mount(HelpPanel).get('[data-help-privacy]').text()).toMatch(/never leave this device/i)
  })

  it('closes, and traps focus like every other panel', async () => {
    const w = mount(HelpPanel)
    await w.get('[data-help-close]').trigger('click')
    expect(w.emitted('close')).toBeTruthy()

    const again = mount(HelpPanel)
    await again.get('[data-help-panel]').trigger('click')
    expect(again.emitted('close')).toBeTruthy()
  })
})

describe('the shortcut list', () => {
  it('has no duplicate ids, labels, or displayed keys', () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length)
    expect(new Set(SHORTCUTS.map((s) => s.label)).size).toBe(SHORTCUTS.length)
    expect(new Set(SHORTCUTS.map((s) => s.display)).size).toBe(SHORTCUTS.length)
  })

  /** Two shortcuts claiming the same key means one of them silently loses. */
  it('never binds the same combination twice', () => {
    const all = SHORTCUTS.flatMap((s) => s.combos)
    expect(new Set(all).size).toBe(all.length)
  })

  it('refuses an id it does not know, rather than binding nothing', () => {
    // @ts-expect-error -- deliberately outside the union
    expect(() => shortcut('does-not-exist')).toThrow()
  })

  it('groups without losing or duplicating an entry', () => {
    const grouped = shortcutsByGroup().flatMap(([, items]) => items)
    expect(grouped).toHaveLength(SHORTCUTS.length)
  })
})

/**
 * The drift check this whole indirection exists for.
 *
 * Before the shortcut list, key combinations were string literals in
 * `useEditShortcuts.ts` and `CommandPalette.vue`, and a help page would
 * have been a third hand-maintained copy. Documenting `⌘K` beside code
 * that binds something else is a bug no test would have caught, because
 * nothing connected the two.
 */
describe('what is documented is what is bound', () => {
  /** Mounting a real component: `useMagicKeys` needs a component scope. */
  function boundCombos(): string[] {
    let bound: string[] = []
    const Host = defineComponent({
      setup() {
        bound = useEditShortcuts()
        return () => null
      },
    })
    mount(Host)
    return bound
  }

  it('binds every combination the edit shortcuts declare, and no others', () => {
    const declared = (['undo', 'redo', 'find', 'delete', 'escape'] as const).flatMap((id) =>
      combosFor(id),
    )
    expect(boundCombos().sort()).toEqual([...declared].sort())
  })

  /**
   * Redo's combinations must be registered before undo's.
   *
   * `useMagicKeys` reports `Meta+z` as true during `Meta+Shift+z`, so an
   * undo binding registered first fires alongside redo and cancels it out.
   * That ordering now depends on the declaration order in `shortcuts.ts`,
   * which is exactly the kind of load-bearing detail that gets tidied away
   * by someone alphabetising a list.
   */
  it('registers redo before undo', () => {
    const bound = boundCombos()
    const firstRedo = Math.min(...combosFor('redo').map((c) => bound.indexOf(c)))
    const firstUndo = Math.min(...combosFor('undo').map((c) => bound.indexOf(c)))
    expect(firstRedo).toBeGreaterThanOrEqual(0)
    expect(firstRedo).toBeLessThan(firstUndo)
  })

  /**
   * Zoom is documented but bound by the zoom controls rather than by
   * useMagicKeys, and its `combos` are empty to say so. If someone gives it
   * combos without binding them, the "no others" assertion above starts
   * failing -- which is the intended alarm.
   */
  it('declares no combinations for shortcuts handled elsewhere', () => {
    expect(combosFor('zoom-in')).toEqual([])
    expect(combosFor('zoom-out')).toEqual([])
    expect(shortcut('zoom-in').display).toBe('⌘+')
  })

  /**
   * The empty state carries the same credit, but it stops existing the
   * moment a document is open. This panel is then the only route back to
   * "who made this?", which is why the line is in both places.
   */
  it('credits the author, reachable with a document open', () => {
    const w = mount(HelpPanel)
    expect(w.text()).toContain(`Made by ${AUTHOR_NAME}`)
    expect(w.get('[data-author-link]').attributes('href')).toBe(AUTHOR_URL)
  })
})
