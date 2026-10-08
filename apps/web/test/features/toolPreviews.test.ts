import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ToolPreview from '@/features/tools/ToolPreview.vue'
import { PREVIEW_HINTS } from '@/features/tools/toolPreviews'
import { TOOLS } from '@/features/tools/toolList'

/** The page itself: a sheet and four text lines. Anything beyond it is the tool. */
const BASE_SHAPES = 5

describe('tool hover previews', () => {
  it('has a hint for every tool the rail offers, and for nothing else', () => {
    const rail = TOOLS.map((t) => t.id).sort()
    expect(Object.keys(PREVIEW_HINTS).sort()).toEqual(rail)
    for (const id of rail) expect(PREVIEW_HINTS[id].length, id).toBeGreaterThan(5)
  })

  it('draws something beyond the blank page for every tool', () => {
    for (const { id } of TOOLS) {
      const w = mount(ToolPreview, { props: { tool: id } })
      const svg = w.get('svg')
      expect(svg.attributes('data-preview')).toBe(id)
      const shapes = svg.element.querySelectorAll('rect, path, ellipse, polygon, circle, line')
      expect(shapes.length, `"${id}" draws nothing`).toBeGreaterThan(BASE_SHAPES)
    }
  })

  it('is hidden from assistive technology', () => {
    const svg = mount(ToolPreview, { props: { tool: 'rect' } }).get('svg')
    expect(svg.attributes('aria-hidden')).toBe('true')
  })
})
