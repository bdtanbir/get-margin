import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import DropZone from '@/features/document/DropZone.vue'
import { useDocumentStore } from '@/stores/document'
import { MAX_BYTES, MAX_PAGES } from '@/lib/limits'

vi.mock('@/lib/autosaveDb', () => ({
  clearEdits: async () => {}, putEdit: async () => {},
  findEdit: async () => undefined, deleteEdit: async () => {},
  pruneEdits: async () => {}, RETENTION_MS: 1, MAX_RECORDS: 20,
}))
vi.mock('@/features/signature/signatureStore', () => ({ clearSignatures: async () => {} }))

describe('DropZone empty state', () => {
  beforeEach(() => setActivePinia(createPinia()))

  const zone = () => mount(DropZone)

  // A newcomer arriving here has no idea what this is; "Open a PDF" tells
  // them what to do but not what they get.
  it('says what the app actually does', () => {
    const text = zone().text()
    expect(text).toMatch(/annotate/i)
    expect(text).toMatch(/sign/i)
    expect(text).toMatch(/export/i)
  })

  // The single thing that most distinguishes this from every other PDF
  // site, and the first thing someone about to upload a contract wants.
  it('leads with the privacy promise', () => {
    expect(zone().text()).toMatch(/Nothing is uploaded/i)
  })

  it('still says how to open a file', () => {
    const w = zone()
    expect(w.text()).toMatch(/Drag a file here/i)
    expect(w.find('input[type=file]').exists()).toBe(true)
  })

  // Stated up front rather than surfaced as an error after a failed open.
  it('states the real limits, read from lib/limits', () => {
    const text = zone().text()
    expect(text).toContain(`${Math.round(MAX_BYTES / 1048576)} MB`)
    expect(text).toContain(String(MAX_PAGES))
  })

  it('offers the detail behind the privacy claim', async () => {
    const w = zone()
    expect(w.find('[data-privacy-page]').exists()).toBe(false)
    await w.get('[data-open-privacy-from-empty]').trigger('click')
    expect(w.find('[data-privacy-page]').exists()).toBe(true)
  })

  it('surfaces an open failure', () => {
    useDocumentStore().error = 'That file is not a PDF.'
    expect(zone().get('[role="alert"]').text()).toContain('not a PDF')
  })
})
