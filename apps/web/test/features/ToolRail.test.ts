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

  it('names the whiteout tool honestly — never "redact"', () => {
    const html = mount(ToolRail).html().toLowerCase()
    expect(html).toContain('whiteout')
    expect(html).not.toContain('redact')
  })
})

// The two shells must offer the same tools: a tool reachable on desktop and
// missing on mobile is a document you cannot finish editing on your phone.
// Both read one shared list, and this is the test that keeps it that way.
describe('ToolStrip', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('offers exactly the same tools as the desktop rail', () => {
    const names = (w: ReturnType<typeof mount>) =>
      w.findAll('button').map((b) => b.attributes('aria-label')).sort()
    expect(names(mount(ToolStrip))).toEqual(names(mount(ToolRail)))
  })

  it('activates a tool on click', async () => {
    const w = mount(ToolStrip)
    await w.get('[aria-label="Highlight"]').trigger('click')
    expect(useToolsStore().active).toBe('highlight')
  })
})
