import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import TopBar from '@/app/TopBar.vue'
import CommandPalette from '@/features/command/CommandPalette.vue'
import { usePaletteStore } from '@/stores/palette'
import { shortcut } from '@/features/help/shortcuts'
import { shortcutLabel } from '@/lib/platform'

vi.mock('@/lib/autosaveDb', () => ({
  clearEdits: async () => {}, putEdit: async () => {}, findEdit: async () => undefined,
  deleteEdit: async () => {}, pruneEdits: async () => {}, RETENTION_MS: 1, MAX_RECORDS: 20,
}))
vi.mock('@/workers/pdfClient', () => ({
  getPdfClient: () => ({ listFields: vi.fn(async () => []), save: vi.fn() }),
  closeSharedDocument: vi.fn(),
}))

beforeEach(() => setActivePinia(createPinia()))

/**
 * The palette held every command in the app and was reachable by one
 * undocumented key. Nothing on screen mentioned it, and the one page that
 * printed the key was itself only reachable through the palette.
 */
describe('discovering the command palette', () => {
  it('shows a control for it in the top bar', () => {
    expect(mount(TopBar).find('[data-open-palette]').exists()).toBe(true)
  })

  it('states the shortcut without being hovered', () => {
    const chip = mount(TopBar).get('[data-palette-shortcut]')
    expect(chip.text()).toBe(shortcutLabel(shortcut('palette').display))
  })

  /**
   * Read from the catalogue, not typed. A chip naming a key nothing binds is
   * worse than no chip.
   */
  it('names the key the palette actually binds', () => {
    expect(mount(TopBar).get('[data-palette-shortcut]').text()).toMatch(/K$/)
  })

  it('opens the palette when clicked', async () => {
    const w = mount(TopBar)
    expect(usePaletteStore().open).toBe(false)
    await w.get('[data-open-palette]').trigger('click')
    expect(usePaletteStore().open).toBe(true)
  })

  /**
   * The pointer route has to reach the same surface the keyboard does --
   * the whole point of lifting `open` out of CommandPalette.
   */
  it('renders the palette once the store says it is open', async () => {
    const w = mount(CommandPalette)
    expect(w.find('[data-command-palette]').exists()).toBe(false)
    usePaletteStore().show()
    await w.vm.$nextTick()
    expect(w.find('[data-command-palette]').exists()).toBe(true)
  })

  /**
   * No ⌘ to press on a phone, so the button is the ONLY way in there. It
   * loses its label and chip to fit, never the control itself.
   */
  it('keeps the control on the compact bar, without the chip', () => {
    const w = mount(TopBar, { props: { compact: true } })
    expect(w.find('[data-open-palette]').exists()).toBe(true)
    expect(w.find('[data-palette-shortcut]').exists()).toBe(false)
  })

  it('names the shortcut for a screen reader even when the chip is hidden', () => {
    const w = mount(TopBar, { props: { compact: true } })
    expect(w.get('[data-open-palette]').attributes('aria-label')).toContain('Commands')
  })
})
