import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { flushPromises } from '@vue/test-utils'
import FontPicker from '@/ui/FontPicker.vue'
import * as fonts from '@/lib/fonts'

const options = [
  { value: 'Inter', label: 'Inter' },
  { value: 'Outfit', label: 'Outfit' },
  { value: 'Tinos', label: 'Tinos (Times New Roman)' },
]

beforeAll(() => {
  // reka's listbox measures and scrolls; jsdom has neither.
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.releasePointerCapture = () => {}
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
})

describe('FontPicker', () => {
  it('draws the closed trigger in the chosen family', () => {
    const w = mount(FontPicker, { props: { modelValue: 'Outfit', options }, attachTo: document.body })
    expect((w.get('button').element as HTMLElement).style.fontFamily).toContain('Outfit')
    w.unmount()
  })

  it('shows each option in its own face and loads the faces when opened', async () => {
    const load = vi.spyOn(fonts, 'loadFont').mockResolvedValue()
    const w = mount(FontPicker, { props: { modelValue: 'Inter', options }, attachTo: document.body })
    expect(load).not.toHaveBeenCalled()
    await w.get('button').trigger('click')
    await nextTick()
    const item = document.body.querySelector('[data-font-option="Outfit"]') as HTMLElement
    expect(item).not.toBeNull()
    expect(item.style.fontFamily).toContain('Outfit')
    expect(document.body.querySelector('[data-font-option="Tinos"]')!.textContent)
      .toContain('Tinos (Times New Roman)')
    expect(load.mock.calls.map((c) => c[0])).toEqual(['Inter', 'Outfit', 'Tinos'])
    w.unmount()
    load.mockRestore()
  })

  it('filters by what the reader types, including the name a face stands in for', async () => {
    const w = mount(FontPicker, { props: { modelValue: 'Inter', options }, attachTo: document.body })
    await w.get('button').trigger('click')
    await nextTick()
    const input = document.body.querySelector('[data-font-search]') as HTMLInputElement
    expect(input).not.toBeNull()
    input.value = 'times'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    const left = [...document.body.querySelectorAll('[data-font-option]')]
      .map((e) => e.getAttribute('data-font-option'))
    expect(left).toEqual(['Tinos'])
    input.value = 'zzz'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    expect(document.body.querySelectorAll('[data-font-option]').length).toBe(0)
    expect(document.body.textContent).toContain('No fonts match')
    w.unmount()
  })
})
