import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import UpdatePrompt from '@/features/pwa/UpdatePrompt.vue'
import { installPwaUpdates, type RegisterSW, type UpdateSW } from '@/lib/pwa/updates'

/** Installs the singleton the component reads, with the hooks exposed. */
function withWaitingWorker(): { updateSW: ReturnType<typeof vi.fn>; announce: () => void } {
  let onNeedRefresh = (): void => {}
  const updateSW = vi.fn(async () => {}) as ReturnType<typeof vi.fn> & UpdateSW
  const register: RegisterSW = (hooks) => {
    onNeedRefresh = hooks.onNeedRefresh
    return updateSW
  }
  installPwaUpdates(register)
  return { updateSW, announce: () => onNeedRefresh() }
}

describe('UpdatePrompt', () => {
  it('shows nothing while the running build is the newest one', () => {
    withWaitingWorker()

    const w = mount(UpdatePrompt)

    expect(w.find('[data-pwa-update]').exists()).toBe(false)
  })

  it('offers the update once a new build is waiting', async () => {
    const { announce } = withWaitingWorker()
    const w = mount(UpdatePrompt)

    announce()
    await w.vm.$nextTick()

    expect(w.find('[data-pwa-update]').exists()).toBe(true)
  })

  it('reloads onto the new build when the user accepts', async () => {
    const { announce, updateSW } = withWaitingWorker()
    const w = mount(UpdatePrompt)
    announce()
    await w.vm.$nextTick()

    await w.find('[data-pwa-update-accept]').trigger('click')

    expect(updateSW).toHaveBeenCalledWith(true)
  })

  it('keeps the running build, and stops asking, when the user declines', async () => {
    const { announce, updateSW } = withWaitingWorker()
    const w = mount(UpdatePrompt)
    announce()
    await w.vm.$nextTick()

    await w.find('[data-pwa-update-dismiss]').trigger('click')

    expect(w.find('[data-pwa-update]').exists()).toBe(false)
    expect(updateSW).not.toHaveBeenCalled()
  })
})
