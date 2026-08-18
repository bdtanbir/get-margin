import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Button from '../../src/ui/Button.vue'

describe('Button', () => {
  it('renders its slot content', () => {
    const w = mount(Button, { slots: { default: 'Download' } })
    expect(w.text()).toContain('Download')
  })

  it('defaults to the secondary variant', () => {
    const w = mount(Button)
    expect(w.classes().join(' ')).toContain('bg-surface')
  })

  it('applies the primary variant', () => {
    const w = mount(Button, { props: { variant: 'primary' } })
    expect(w.classes().join(' ')).toContain('bg-accent')
  })

  it('emits click when enabled', async () => {
    const w = mount(Button)
    await w.trigger('click')
    expect(w.emitted('click')).toHaveLength(1)
  })

  it('does not emit click when disabled', async () => {
    const w = mount(Button, { props: { disabled: true } })
    await w.trigger('click')
    expect(w.emitted('click')).toBeUndefined()
    expect(w.attributes('disabled')).toBeDefined()
  })

  it('is disabled and busy while loading', async () => {
    const w = mount(Button, { props: { loading: true } })
    expect(w.attributes('disabled')).toBeDefined()
    expect(w.attributes('aria-busy')).toBe('true')
    await w.trigger('click')
    expect(w.emitted('click')).toBeUndefined()
  })

  it('defaults type to button so it never submits a form by accident', () => {
    expect(mount(Button).attributes('type')).toBe('button')
  })
})
