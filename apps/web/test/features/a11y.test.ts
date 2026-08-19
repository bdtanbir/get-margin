import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import PageGrid from '@/features/pages/PageGrid.vue'
import SplitDialog from '@/features/pages/SplitDialog.vue'
import CropOverlay from '@/features/pages/CropOverlay.vue'
import PrivacyPage from '@/features/document/PrivacyPage.vue'
import ToolRail from '@/features/tools/ToolRail.vue'
import { useDocumentStore } from '@/stores/document'
import { useToolsStore } from '@/stores/tools'
import { seedPages } from '../helpers/seedDocument'

vi.mock('@/lib/autosaveDb', () => ({
  clearEdits: async () => {}, putEdit: async () => {},
  findEdit: async () => undefined, deleteEdit: async () => {},
  pruneEdits: async () => {}, RETENTION_MS: 1, MAX_RECORDS: 20,
}))
vi.mock('@/features/signature/signatureStore', () => ({
  clearSignatures: async () => {}, listSignatures: async () => [],
  saveSignature: async () => {}, deleteSignature: async () => {},
}))

/**
 * Modal surfaces owe keyboard users three things. Before this suite, all
 * of them trapped focus only by accident -- which is to say, not at all.
 */
describe('modal surfaces', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    seedPages(3)
    useToolsStore().setTool('crop')
  })

  const surfaces: Array<[string, () => VueWrapper]> = [
    ['split', () => mount(SplitDialog, { attachTo: document.body })],
    ['crop', () => mount(CropOverlay, {
      props: { page: useDocumentStore().pages.p0!, zoom: 1 },
      attachTo: document.body,
    })],
    ['privacy', () => mount(PrivacyPage, { attachTo: document.body })],
  ]

  it.each(surfaces)('%s moves focus into itself on open', async (_name, open) => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()

    const w = open()
    await nextTick()
    expect(w.element.contains(document.activeElement)).toBe(true)
    w.unmount()
    opener.remove()
  })

  it.each(surfaces)('%s returns focus when it closes', async (_name, open) => {
    const opener = document.createElement('button')
    opener.id = 'opener'
    document.body.appendChild(opener)
    opener.focus()

    const w = open()
    await nextTick()
    w.unmount()
    expect(document.activeElement?.id).toBe('opener')
    opener.remove()
  })

  it.each(surfaces)('%s closes on Escape', async (_name, open) => {
    const w = open()
    await nextTick()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    // Either it emitted close, or it handed the tool back to select.
    const closed = w.emitted('close') !== undefined || useToolsStore().active === 'select'
    expect(closed).toBe(true)
    w.unmount()
  })
})

describe('page grid semantics', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    seedPages(3)
  })

  // role=option on its own tells a screen reader an option exists but not
  // what it belongs to, nor that several can be chosen.
  it('puts the tiles inside a multi-selectable listbox', () => {
    const w = mount(PageGrid)
    const list = w.get('[role="listbox"]')
    expect(list.attributes('aria-multiselectable')).toBe('true')
    expect(list.attributes('aria-label')).toBeTruthy()
    expect(list.findAll('[role="option"]').length).toBe(3)
  })

  it('marks selection state on every tile, not just the selected one', async () => {
    const w = mount(PageGrid)
    for (const tile of w.findAll('[role="option"]')) {
      expect(tile.attributes('aria-selected')).toBeDefined()
    }
  })
})

describe('icon-only controls', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    seedPages(3)
  })

  // An icon with no accessible name is a button a screen-reader user cannot
  // identify at all.
  it.each([
    ['the tool rail', () => mount(ToolRail)],
    ['the page grid', () => mount(PageGrid)],
  ])('every control in %s has an accessible name', (_name, open) => {
    const w = open()
    for (const button of w.findAll('button')) {
      const named =
        (button.text().trim().length > 0) ||
        Boolean(button.attributes('aria-label')) ||
        Boolean(button.attributes('aria-labelledby'))
      expect(named, `unnamed button: ${button.html().slice(0, 80)}`).toBe(true)
    }
  })
})
