import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import ToolRail from '@/features/tools/ToolRail.vue'
import ToolStrip from '@/features/tools/ToolStrip.vue'
import { useToolsStore } from '@/stores/tools'

describe('ToolRail', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('gives every tool button an accessible name', () => {
    const w = mount(ToolRail)
    const buttons = w.findAll('button')
    expect(buttons.length).toBeGreaterThan(5)
    for (const b of buttons) expect(b.attributes('aria-label')).toBeTruthy()
  })

  it('marks the active tool with aria-pressed', async () => {
    const w = mount(ToolRail)
    const rect = w.get('[aria-label="Rectangle"]')
    expect(rect.attributes('aria-pressed')).toBe('false')
    useToolsStore().setTool('rect')
    await w.vm.$nextTick()
    expect(w.get('[aria-label="Rectangle"]').attributes('aria-pressed')).toBe('true')
  })

  it('activates a tool on click', async () => {
    const w = mount(ToolRail)
    await w.get('[aria-label="Whiteout"]').trigger('click')
    expect(useToolsStore().active).toBe('whiteout')
  })

  /**
   * Narrowed in Phase 6, when a real redaction shipped -- see
   * whiteoutHonesty.test.ts for the full reasoning. The claim that matters
   * is that WHITEOUT is not called redaction, not that the word is absent.
   */
  it('names the whiteout tool honestly — never "redact"', () => {
    const labels = mount(ToolRail).findAll('button')
      .map((b) => (b.attributes('aria-label') ?? '').toLowerCase())
    expect(labels).toContain('whiteout')
    // Exactly one control may carry the word, and it is the one that
    // genuinely removes text.
    expect(labels.filter((l) => l.includes('redact'))).toEqual(['redact'])
  })
})

// The two shells must offer the same tools: a tool reachable on desktop and
// missing on mobile is a document you cannot finish editing on your phone.
// Both read one shared list, and this is the test that keeps it that way.
describe('ToolStrip', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('offers exactly the same tools as the desktop rail', () => {
    // Collapsing is the desktop rail's own business: the strip has no width
    // to give back, so its toggle is not a tool the strip is missing.
    const names = (w: ReturnType<typeof mount>) =>
      w.findAll('button:not([data-rail-toggle])').map((b) => b.attributes('aria-label')).sort()
    expect(names(mount(ToolStrip))).toEqual(names(mount(ToolRail)))
  })

  it('activates a tool on click', async () => {
    const w = mount(ToolStrip)
    await w.get('[aria-label="Highlight"]').trigger('click')
    expect(useToolsStore().active).toBe('highlight')
  })
})

/**
 * Like WordPress's admin menu: names beside the icons by default, and a
 * "Collapse menu" control that folds the rail to icons only.
 */
describe('ToolRail collapse', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  const toolNames = (w: ReturnType<typeof mount>) =>
    w.findAll('[data-tool]').map((b) => b.text())

  it('puts Edit text straight after Select', () => {
    const labels = mount(ToolRail).findAll('[data-tool]').map((b) => b.attributes('aria-label'))
    expect(labels.slice(0, 2)).toEqual(['Select', 'Edit text'])
  })

  it('opens with every tool named', () => {
    const w = mount(ToolRail)
    expect(w.get('nav').attributes('data-rail-expanded')).toBe('true')
    expect(toolNames(w)).toContain('Edit text')
    expect(w.get('[data-rail-toggle]').text()).toBe('Collapse menu')
  })

  it('collapses to icons only, and expands again', async () => {
    const w = mount(ToolRail)
    await w.get('[data-rail-toggle]').trigger('click')
    expect(w.get('nav').attributes('data-rail-expanded')).toBe('false')
    // The names stay in place, faded and clipped by the narrow rail, so
    // nothing moves while the width animates -- and hidden from assistive
    // technology, which has each button's aria-label instead.
    for (const l of w.findAll('[data-rail-label]')) {
      expect(l.classes()).toContain('opacity-0')
      expect(l.attributes('aria-hidden')).toBe('true')
    }
    expect(w.get('[data-rail-toggle]').attributes('aria-label')).toBe('Expand menu')
    // Still named for assistive technology, folded or not.
    expect(w.get('[data-tool]').attributes('aria-label')).toBe('Select')

    await w.get('[data-rail-toggle]').trigger('click')
    expect(toolNames(w)).toContain('Select')
    expect(w.get('[data-rail-label]').classes()).toContain('opacity-100')
  })

  /**
   * Reported: opening the rail centred the icons and then slid them left.
   * A row's layout must not depend on the state -- only the rail's width.
   */
  it('lays every row out the same way folded and open', async () => {
    const w = mount(ToolRail)
    const open = w.get('[data-tool]').classes().sort()
    await w.get('[data-rail-toggle]').trigger('click')
    expect(w.get('[data-tool]').classes().sort()).toEqual(open)
  })

  it('always opens named, even after being collapsed', async () => {
    const first = mount(ToolRail)
    await first.get('[data-rail-toggle]').trigger('click')
    first.unmount()
    expect(mount(ToolRail).get('nav').attributes('data-rail-expanded')).toBe('true')
  })
})
