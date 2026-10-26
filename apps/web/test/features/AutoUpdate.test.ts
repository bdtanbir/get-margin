import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import AutoUpdate from '@/features/pwa/AutoUpdate.vue'
import { installPwaUpdates, type RegisterSW, type UpdateSW } from '@/lib/pwa/updates'
import { useDocumentStore } from '@/stores/document'

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

/**
 * Reported: "if there is a new version then it should automatically get
 * it, no need to click Reload". It does -- but never under an open file.
 */
describe('AutoUpdate', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('does nothing while the running build is the newest one', () => {
    const { updateSW } = withWaitingWorker()
    mount(AutoUpdate)
    expect(updateSW).not.toHaveBeenCalled()
  })

  it('takes a new build straight away when no document is open', async () => {
    const { announce, updateSW } = withWaitingWorker()
    const w = mount(AutoUpdate)
    announce()
    await w.vm.$nextTick()
    expect(updateSW).toHaveBeenCalledWith(true)
  })

  it('waits while a document is open, and takes it once that is closed', async () => {
    const { announce, updateSW } = withWaitingWorker()
    const doc = useDocumentStore()
    doc.status = 'ready' as never
    const w = mount(AutoUpdate)
    announce()
    await w.vm.$nextTick()
    expect(updateSW).not.toHaveBeenCalled()

    doc.status = 'empty'
    await w.vm.$nextTick()
    expect(updateSW).toHaveBeenCalledWith(true)
  })

  it('shows no prompt and no button', async () => {
    const { announce } = withWaitingWorker()
    const w = mount(AutoUpdate)
    announce()
    await w.vm.$nextTick()
    expect(w.find('button').exists()).toBe(false)
    expect(w.text()).toBe('')
  })
})
