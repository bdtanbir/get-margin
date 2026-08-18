import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import PasswordPrompt from '../../src/features/document/PasswordPrompt.vue'
import { useDocumentStore } from '../../src/stores/document.js'

vi.mock('../../src/workers/pdfClient.js', () => ({
  createPdfClient: () => ({
    open: vi.fn(), authenticate: vi.fn(), render: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined), terminate: vi.fn(),
  }),
  getPdfClient: () => ({
    open: vi.fn(), authenticate: vi.fn(), render: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined), terminate: vi.fn(),
  }),
  closeSharedDocument: vi.fn().mockResolvedValue(undefined),
}))

beforeEach(() => setActivePinia(createPinia()))

describe('PasswordPrompt', () => {
  it('uses a password input so the value is never visible or autofilled as text', () => {
    const w = mount(PasswordPrompt)
    expect(w.find('input').attributes('type')).toBe('password')
  })

  it('submits the entered password to the store', async () => {
    const doc = useDocumentStore()
    const spy = vi.spyOn(doc, 'submitPassword').mockResolvedValue()
    const w = mount(PasswordPrompt)
    await w.find('input').setValue('hunter2')
    await w.find('form').trigger('submit')
    expect(spy).toHaveBeenCalledWith('hunter2')
  })

  it('does not submit an empty password', async () => {
    const doc = useDocumentStore()
    const spy = vi.spyOn(doc, 'submitPassword').mockResolvedValue()
    const w = mount(PasswordPrompt)
    await w.find('form').trigger('submit')
    expect(spy).not.toHaveBeenCalled()
  })

  it('shows the store error in an alert region', async () => {
    const doc = useDocumentStore()
    doc.$patch({ status: 'needs-password', error: 'Incorrect password' })
    const w = mount(PasswordPrompt)
    expect(w.find('[role="alert"]').text()).toMatch(/incorrect password/i)
  })

  it('clears the field after a failed attempt', async () => {
    const doc = useDocumentStore()
    vi.spyOn(doc, 'submitPassword').mockImplementation(async () => {
      doc.$patch({ status: 'needs-password', error: 'Incorrect password' })
    })
    const w = mount(PasswordPrompt)
    await w.find('input').setValue('wrong')
    await w.find('form').trigger('submit')
    await w.vm.$nextTick()
    expect((w.find('input').element as HTMLInputElement).value).toBe('')
  })
})
