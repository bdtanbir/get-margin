import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import IconButton from '../../src/ui/IconButton.vue'

describe('IconButton', () => {
  it('exposes the label to assistive technology', () => {
    const w = mount(IconButton, { props: { label: 'Rotate page' } })
    expect(w.attributes('aria-label')).toBe('Rotate page')
  })

  it('reports pressed state when active', () => {
    const w = mount(IconButton, { props: { label: 'Text tool', active: true } })
    expect(w.attributes('aria-pressed')).toBe('true')
  })

  it('omits aria-pressed when active is not supplied', () => {
    const w = mount(IconButton, { props: { label: 'Zoom in' } })
    expect(w.attributes('aria-pressed')).toBeUndefined()
  })

  it('meets the 44px touch-target minimum at md size', () => {
    // Spec Global Constraints: 44px minimum on the mobile shell.
    const w = mount(IconButton, { props: { label: 'x' } })
    expect(w.classes().join(' ')).toMatch(/min-h-11/)
  })
})
