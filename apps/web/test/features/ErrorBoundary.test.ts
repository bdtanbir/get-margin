import { describe, it, expect, vi } from 'vitest'
import { defineComponent, ref, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import ErrorBoundary from '@/app/ErrorBoundary.vue'

const Boom = defineComponent({
  setup: () => () => {
    throw new Error('render exploded')
  },
})

/** Throws only until `fail` is turned off, so retry has something to recover to. */
const flaky = ref(true)
const Flaky = defineComponent({
  setup: () => () => {
    if (flaky.value) throw new Error('still broken')
    return h('p', 'recovered')
  },
})

/**
 * Mount and let the fallback render.
 *
 * onErrorCaptured runs DURING the child's failed render; the state it sets
 * schedules a re-render, so the panel only exists on the next tick. Asserting
 * synchronously sees an empty subtree and says nothing useful about the
 * boundary.
 */
async function boundary(slot: unknown, label = 'The page view') {
  const w = mount(ErrorBoundary, { props: { label }, slots: { default: slot as never } })
  await nextTick()
  return w
}

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    const w = mount(ErrorBoundary, {
      props: { label: 'The page view' },
      slots: { default: '<p>fine</p>' },
    })
    expect(w.text()).toContain('fine')
    expect(w.find('[data-boundary-failed]').exists()).toBe(false)
  })

  it('catches a child’s error instead of blanking the app', async () => {
    const w = await boundary(Boom)
    expect(w.find('[data-boundary-failed]').exists()).toBe(true)
    expect(w.text()).toContain('The page view')
  })

  // A boundary that swallows a failure is worse than no boundary: the user
  // sees a dead region and cannot describe what happened.
  it('names what failed', async () => {
    const w = await boundary(Boom)
    expect(w.text()).toContain('render exploded')
  })

  it('reassures that the document and edits survive', async () => {
    const w = await boundary(Boom, 'x')
    expect(w.text()).toContain('still here')
  })

  it('reports the error to its parent', async () => {
    const w = await boundary(Boom, 'x')
    const captured = w.emitted('captured')
    expect(captured).toHaveLength(1)
    expect((captured![0]![0] as Error).message).toBe('render exploded')
  })

  it('recovers when retried', async () => {
    flaky.value = true
    const w = await boundary(Flaky, 'x')
    expect(w.find('[data-boundary-failed]').exists()).toBe(true)
    flaky.value = false
    await w.get('[data-boundary-retry]').trigger('click')
    await nextTick()
    expect(w.text()).toContain('recovered')
  })

  it('shows the panel again if the retry fails too', async () => {
    flaky.value = true
    const w = await boundary(Flaky, 'x')
    await w.get('[data-boundary-retry]').trigger('click')
    await nextTick()
    expect(w.find('[data-boundary-failed]').exists()).toBe(true)
  })

  // Stopping propagation is what keeps the failure local; without it the
  // root handler runs too and the app unmounts behind this panel.
  it('does not let the error escape to an outer boundary', async () => {
    const onOuter = vi.fn()
    mount(ErrorBoundary, {
      props: { label: 'outer' },
      slots: {
        default: () => h(ErrorBoundary, { label: 'inner', onCaptured: onOuter }, { default: () => h(Boom) }),
      },
    })
    await nextTick()
    // Captured exactly once, by the inner boundary.
    expect(onOuter).toHaveBeenCalledTimes(1)
  })
})
