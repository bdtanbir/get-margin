import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import PrivacyPage from '@/features/document/PrivacyPage.vue'
import { MAX_BYTES, MAX_PAGES } from '@/lib/limits'
import { emptyEditDocument } from '@margin/pdf-core'

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

  /**
   * It is opened from two places, and one of them -- DropZone's empty state
   * -- is a `text-center` card. `position: fixed` escapes the layout but not
   * inheritance, so opened from there this page rendered centred, bulleted
   * list and all, while opening it from the top bar looked correct.
   */
  it('pins its own text alignment, so a centred parent cannot centre it', () => {
    expect(page().get('[data-privacy-page]').classes()).toContain('text-left')
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

  it('names the answers typed into form fields', () => {
    expect(page().text()).toMatch(/form fields/i)
  })

  it('names the stored file name', () => {
    expect(page().text()).toMatch(/name of each file/i)
  })

  /**
   * NOT a claim that nothing identifying is stored -- which is false the
   * moment someone types their name into a text box or a form field. A
   * privacy page that overclaims on the part a user can check is not worth
   * reading on the parts they cannot.
   */
  it('does not claim that nothing identifying is stored', () => {
    expect(page().text()).not.toMatch(/anything identifying you/i)
  })
})

/**
 * THE STRUCTURAL GUARD, and the reason it exists.
 *
 * Every test above pins a claim the page already makes. None of them could
 * notice a NEW category of stored data appearing -- which is exactly what
 * happened: Phase 5 added `fieldValues` to the autosaved document, so the
 * answers someone types into a tax form began being written to IndexedDB,
 * and this page went on listing three things and claiming nothing
 * identifying was kept.
 *
 * This forces a DECISION rather than a wording. Adding a key to the
 * autosave record fails here until someone says, in this map, whether the
 * privacy page has to mention it and why.
 */
describe('the privacy page covers everything actually stored', () => {
  /** Top-level keys of SavedEdit, and what the page owes each one. */
  const RECORD_KEYS: Record<string, { mustAppear: RegExp | null; because: string }> = {
    hash: { mustAppear: /fingerprint/i, because: 'a fingerprint of the file identifies the record' },
    name: { mustAppear: /name of each file/i, because: 'the file name is personal data' },
    savedAt: { mustAppear: null, because: 'a timestamp on data already disclosed' },
    doc: { mustAppear: /Your edits/i, because: 'the edit document is the payload' },
  }

  /** Top-level keys of EditDocument, which travels inside `doc`. */
  const DOC_KEYS: Record<string, { mustAppear: RegExp | null; because: string }> = {
    version: { mustAppear: null, because: 'a schema number, not user data' },
    sources: { mustAppear: /name of each file/i, because: 'holds each file name and hash' },
    pageOrder: { mustAppear: /page changes/i, because: 'page structure the user chose' },
    pages: { mustAppear: /page changes/i, because: 'rotation and crop the user chose' },
    objects: { mustAppear: /Annotations, shapes, text/i, because: 'everything the user drew or typed' },
    nextZ: { mustAppear: null, because: 'a counter, not user data' },
    fieldValues: { mustAppear: /form fields/i, because: 'form answers are frequently personal' },
    flattenForms: { mustAppear: null, because: 'an export preference, not user data' },
  }

  const text = () => mount(PrivacyPage).text()

  it('accounts for every key of the autosave record', () => {
    // SavedEdit's shape, spelled here because a type has no runtime keys.
    expect(Object.keys(RECORD_KEYS).sort()).toEqual(['doc', 'hash', 'name', 'savedAt'])
  })

  it('accounts for every key of the edit document it stores', () => {
    expect(Object.keys(DOC_KEYS).sort()).toEqual(Object.keys(emptyEditDocument()).sort())
  })

  it('says something about every key that holds user data', () => {
    const body = text()
    for (const [key, rule] of Object.entries({ ...RECORD_KEYS, ...DOC_KEYS })) {
      if (!rule.mustAppear) continue
      expect(body, `${key}: ${rule.because}`).toMatch(rule.mustAppear)
    }
  })
})
/**
 * The one claim on this page that a build flag can falsify.
 *
 * Phase 6 already had to fix this page for understating what is stored;
 * this is the same failure in the other direction, and it is worse, because
 * "nothing is uploaded, and there is no server to upload it to" is the
 * sentence the whole page rests on.
 */
describe('the upload claim tracks whether a conversion service exists', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetModules()
  })

  async function pageWith(baseUrl: string) {
    vi.doMock('@/features/convert/useJob', () => ({
      conversionAvailable: () => baseUrl.length > 0,
    }))
    const Page = (await import('@/features/document/PrivacyPage.vue')).default
    return mount(Page)
  }

  it('claims outright that there is no server, in the build that has none', async () => {
    const w = await pageWith('')
    expect(w.get('[data-privacy-local]').text()).toMatch(/no server to upload it to/i)
    expect(w.text()).toMatch(/never leave this device/i)
    expect(w.find('[data-privacy-convert]').exists()).toBe(false)
  })

  it('claims no analytics only in a build that cannot send any', async () => {
    // A real computed, not a plain object with a `.value`: the template
    // reads `telemetry.configured`, and Vue only auto-unwraps actual refs.
    // A look-alike silently resolves to undefined and the test passes for
    // the wrong reason.
    vi.doMock('@/lib/telemetry/analytics', async () => {
      const { computed } = await import('vue')
      return {
        telemetryState: computed(() => ({ configured: false, choice: 'unset', sending: false })),
      }
    })
    const w = await pageWith('')
    expect(w.text()).toMatch(/there are no analytics/i)
    expect(w.find('[data-privacy-telemetry]').exists()).toBe(false)
  })

  it('describes usage counts, and their state, in a build that can send them', async () => {
    vi.doMock('@/lib/telemetry/analytics', async () => {
      const { computed } = await import('vue')
      return {
        telemetryState: computed(() => ({ configured: true, choice: 'granted', sending: true })),
      }
    })
    const w = await pageWith('')
    // The unqualified claim is gone, because it would no longer be true.
    expect(w.text()).not.toMatch(/there are no analytics/i)

    const telemetry = w.get('[data-privacy-telemetry]').text()
    expect(telemetry).toMatch(/usage counts are on/i)
    expect(telemetry).toMatch(/never a document/i)
    expect(telemetry).toMatch(/never a file name/i)
    expect(telemetry).toMatch(/off until you say yes/i)
  })

  it('names the exception, and its deletion policy, in a build that has one', async () => {
    const w = await pageWith('https://convert.example')
    // The absolute claim is gone, because it would no longer be true.
    expect(w.get('[data-privacy-local]').text()).not.toMatch(/no server to upload it to/i)

    const exception = w.get('[data-privacy-convert]').text()
    expect(exception).toMatch(/file conversion/i)
    expect(exception).toMatch(/only after you are shown/i)
    expect(exception).toMatch(/deleted as soon as you download/i)
    expect(exception).toMatch(/within an hour/i)
    expect(exception).toMatch(/never stored or logged/i)
  })
})
