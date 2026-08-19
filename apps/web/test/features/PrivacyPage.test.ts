import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import PrivacyPage from '@/features/document/PrivacyPage.vue'
import { MAX_BYTES, MAX_PAGES } from '@/lib/limits'

const clearEdits = vi.fn(async () => {})
const clearSignatures = vi.fn(async () => {})

vi.mock('@/lib/autosaveDb', () => ({ clearEdits: () => clearEdits() }))
vi.mock('@/features/signature/signatureStore', () => ({ clearSignatures: () => clearSignatures() }))

/**
 * This page is a promise. Each test below pins one clause of it, because a
 * privacy page that drifts from what the code does is worse than none --
 * and the code it describes is lib/autosaveDb.ts,
 * features/signature/signatureStore.ts, and lib/theme.ts.
 */
describe('PrivacyPage', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  const page = () => mount(PrivacyPage)

  it('states that files are never uploaded', () => {
    expect(page().text()).toContain('never leave this device')
  })

  it('says there is no backend at all', () => {
    expect(page().text()).toMatch(/no backend/i)
  })

  // Claiming "nothing is stored" would be false, and false about the easy
  // part. Each of the three things the app actually writes is named.
  it('names the autosaved edits', () => {
    expect(page().text()).toMatch(/Your edits/)
  })

  it('names saved signatures and that they are opt-in', () => {
    const text = page().text()
    expect(text).toMatch(/signatures/i)
    expect(text).toMatch(/Unticked by default/i)
  })

  it('names the theme preference', () => {
    expect(page().text()).toMatch(/theme preference/i)
  })

  // The distinction the whole autosave design turns on.
  it('says the PDF itself is not stored, only the edits', () => {
    expect(page().text()).toContain('never stored')
  })

  it('never claims that nothing at all is stored', () => {
    expect(page().text().toLowerCase()).not.toContain('nothing is stored')
  })

  it('states the real limits rather than leaving them to a failed open', () => {
    const text = page().text()
    expect(text).toContain(`${Math.round(MAX_BYTES / (1024 * 1024))} MB`)
    expect(text).toContain(String(MAX_PAGES))
  })

  // Stripping changes the user's file; the page that explains the product's
  // handling of their data is where that belongs.
  it('explains that exports have scripts removed', () => {
    expect(page().text()).toMatch(/JavaScript and automatic actions removed/i)
  })

  it('warns that form validation scripts go too', () => {
    expect(page().text()).toMatch(/form validation/i)
  })

  // Telling someone what you keep without offering to delete it is half an
  // answer.
  it('clears every store on request', async () => {
    const w = page()
    await w.get('[data-privacy-clear]').trigger('click')
    await flushPromises()
    expect(clearEdits).toHaveBeenCalledTimes(1)
    expect(clearSignatures).toHaveBeenCalledTimes(1)
    expect(w.find('[data-privacy-cleared]').exists()).toBe(true)
  })

  it('closes', async () => {
    const w = page()
    await w.get('[data-privacy-close]').trigger('click')
    expect(w.emitted('close')).toBeTruthy()
  })
})
