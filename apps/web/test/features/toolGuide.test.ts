import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import ToolsGuide from '@/features/help/ToolsGuide.vue'
import ToolRail from '@/features/tools/ToolRail.vue'
import ToolStrip from '@/features/tools/ToolStrip.vue'
import { useDialogsStore } from '@/stores/dialogs'
import { TOOL_DOCS } from '@/features/help/toolGuide'
import { TOOLS } from '@/features/tools/toolList'

vi.mock('@/lib/autosaveDb', () => ({
  clearEdits: async () => {}, putEdit: async () => {}, findEdit: async () => undefined,
  deleteEdit: async () => {}, pruneEdits: async () => {}, RETENTION_MS: 1, MAX_RECORDS: 20,
}))

beforeEach(() => setActivePinia(createPinia()))

describe('the tool guide catalogue', () => {
  /**
   * The anti-drift pair. A tool added to the rail with no entry here, or an
   * entry left behind by a tool that was removed, fails rather than ships.
   */
  it('documents every tool the rail offers', () => {
    for (const tool of TOOLS) {
      expect(TOOL_DOCS[tool.id], `no guide entry for "${tool.id}"`).toBeTruthy()
    }
  })

  it('documents nothing that is not in the rail', () => {
    const rail = new Set(TOOLS.map((t) => t.id))
    for (const id of Object.keys(TOOL_DOCS)) {
      expect(rail.has(id as never), `"${id}" is documented but not in the rail`).toBe(true)
    }
  })

  it('says both what each tool is for and how to use it', () => {
    for (const tool of TOOLS) {
      const doc = TOOL_DOCS[tool.id]
      expect(doc.does.length, `${tool.id}: "does" is too thin to help`).toBeGreaterThan(20)
      expect(doc.how.length, `${tool.id}: "how" is too thin to help`).toBeGreaterThan(15)
    }
  })

  /**
   * The one piece of copy in this file that is a user-harm control rather
   * than a description. Whiteout COVERS and redaction REMOVES; a user who
   * has these the wrong way round publishes a document believing a name is
   * gone when it is still selectable in the file.
   */
  it('warns that whiteout does not remove what it covers, and points at redact', () => {
    const caution = TOOL_DOCS.whiteout.caution ?? ''
    expect(caution).toMatch(/still in the file|can still be copied/i)
    expect(caution).toMatch(/redact/i)
  })

  it('records that redaction covers text only, not images', () => {
    expect(TOOL_DOCS.redact.caution ?? '').toMatch(/image/i)
  })
})

describe('ToolsGuide', () => {
  it('lists every tool, once', () => {
    const w = mount(ToolsGuide)
    const rows = w.findAll('[data-tool-doc]')
    expect(rows).toHaveLength(TOOLS.length)
    expect(new Set(rows.map((r) => r.attributes('data-tool-doc'))).size).toBe(TOOLS.length)
  })

  /**
   * In the RAIL's order, not the catalogue's. Someone reads this with the
   * toolbar in front of them, and a guide numbered in a different order
   * than the icons it describes is worse than no numbering.
   */
  it('lists them in the order the rail draws them', () => {
    const rendered = mount(ToolsGuide).findAll('[data-tool-doc]').map((r) => r.attributes('data-tool-doc'))
    expect(rendered).toEqual(TOOLS.map((t) => t.id))
  })

  it('shows each tool its label and both lines of prose', () => {
    const w = mount(ToolsGuide)
    for (const tool of TOOLS) {
      const row = w.get(`[data-tool-doc="${tool.id}"]`)
      expect(row.text(), tool.id).toContain(tool.label)
      expect(row.text(), tool.id).toContain(TOOL_DOCS[tool.id].does)
      expect(row.text(), tool.id).toContain(TOOL_DOCS[tool.id].how)
    }
  })

  it('renders a caution only where one is declared', () => {
    const w = mount(ToolsGuide)
    for (const tool of TOOLS) {
      const has = w.find(`[data-tool-caution="${tool.id}"]`).exists()
      expect(has, tool.id).toBe(Boolean(TOOL_DOCS[tool.id].caution))
    }
  })

  /**
   * Both entry points mount this INSIDE DropZone's card, which is
   * `text-center` so its own copy reads as a centred empty state. `position:
   * fixed` takes the dialog out of the flow but not out of inheritance, so
   * the guide came out centred -- eighteen ragged descriptions and a column
   * of icons that no longer lined up with them. PrivacyPage had shipped with
   * the same bug for the same reason.
   *
   * Asserted on the class rather than on computed style because jsdom
   * resolves no Tailwind; the class IS the contract here.
   */
  it('pins its own text alignment, so a centred parent cannot centre it', () => {
    expect(mount(ToolsGuide).get('[data-tools-guide]').classes()).toContain('text-left')
  })

  it('closes on the close button', async () => {
    const w = mount(ToolsGuide)
    await w.get('[data-tools-guide-close]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })
})

/**
 * The guide existed before this and was, in the edit page, invisible: the
 * command palette opened it, the help panel linked to it, and the help
 * panel itself was only reachable through the command palette. Nothing on
 * screen led to any of it, so the documentation for eighteen icons was
 * gated behind knowing a keyboard shortcut for a menu you had never seen.
 */
describe('reaching the guide from the edit page', () => {
  for (const [name, Rail] of [['desktop rail', ToolRail], ['mobile strip', ToolStrip]] as const) {
    it(`${name}: offers a visible control that opens the guide`, async () => {
      const w = mount(Rail)
      const button = w.get('[data-open-tools-guide-rail]')
      expect(button.attributes('aria-label') ?? button.text()).toMatch(/what each tool does/i)

      expect(useDialogsStore().isOpen('tools-guide')).toBe(false)
      await button.trigger('click')
      expect(useDialogsStore().isOpen('tools-guide')).toBe(true)
    })

    /**
     * Pinned, not appended. Eighteen buttons overflow both rails, and a
     * control that scrolls out of view is the bug this test exists for.
     */
    it(`${name}: keeps it outside the scrolling tool list`, () => {
      const w = mount(Rail)
      const scroller = w.get('.overflow-y-auto')
      expect(scroller.find('[data-open-tools-guide-rail]').exists()).toBe(false)
    })
  }
})
