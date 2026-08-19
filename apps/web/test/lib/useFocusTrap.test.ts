import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, ref, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { useFocusTrap } from '@/lib/useFocusTrap'

const onEscape = vi.fn()

const Modal = defineComponent({
  setup() {
    const el = ref<HTMLElement | null>(null)
    useFocusTrap(el, { onEscape })
    return () =>
      h('div', { ref: el, tabindex: -1 }, [
        h('button', { id: 'first' }, 'first'),
        h('input', { id: 'middle' }),
        h('button', { id: 'last' }, 'last'),
      ])
  },
})

const Empty = defineComponent({
  setup() {
    const el = ref<HTMLElement | null>(null)
    useFocusTrap(el, {})
    return () => h('div', { ref: el, tabindex: -1 }, 'nothing focusable')
  },
})

function tab(shift = false): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true }))
}

describe('useFocusTrap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  it('moves focus into the surface on open', async () => {
    mount(Modal, { attachTo: document.body })
    await nextTick()
    expect(document.activeElement?.id).toBe('first')
  })

  // Without this the next Tab lands on the page underneath, which is
  // unreachable and usually hidden behind the overlay.
  it('wraps Tab from the last control back to the first', async () => {
    const w = mount(Modal, { attachTo: document.body })
    await nextTick()
    w.get('#last').element.dispatchEvent(new FocusEvent('focus'))
    ;(w.get('#last').element as HTMLElement).focus()
    tab()
    expect(document.activeElement?.id).toBe('first')
  })

  it('wraps Shift+Tab from the first control back to the last', async () => {
    const w = mount(Modal, { attachTo: document.body })
    await nextTick()
    ;(w.get('#first').element as HTMLElement).focus()
    tab(true)
    expect(document.activeElement?.id).toBe('last')
  })

  it('leaves Tab alone in the middle of the surface', async () => {
    const w = mount(Modal, { attachTo: document.body })
    await nextTick()
    ;(w.get('#middle').element as HTMLElement).focus()
    tab()
    // Not intercepted: the browser's own order takes it from here.
    expect(document.activeElement?.id).toBe('middle')
  })

  it('routes Escape to the caller rather than deciding what closing means', async () => {
    mount(Modal, { attachTo: document.body })
    await nextTick()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  // Usually the forgotten half: without it the user lands back at the top
  // of the document with no idea where they were.
  it('returns focus to whatever opened it', async () => {
    const opener = document.createElement('button')
    opener.id = 'opener'
    document.body.appendChild(opener)
    opener.focus()

    const w = mount(Modal, { attachTo: document.body })
    await nextTick()
    expect(document.activeElement?.id).toBe('first')
    w.unmount()
    expect(document.activeElement?.id).toBe('opener')
  })

  it('stops listening after unmount', async () => {
    const w = mount(Modal, { attachTo: document.body })
    await nextTick()
    w.unmount()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onEscape).not.toHaveBeenCalled()
  })

  it('does not let Tab escape a surface with nothing focusable', async () => {
    mount(Empty, { attachTo: document.body })
    await nextTick()
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
  })
})
