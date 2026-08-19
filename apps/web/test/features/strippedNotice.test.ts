import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import TopBar from '@/app/TopBar.vue'
import { useEditsStore } from '@/stores/edits'
import { seedPages } from '../helpers/seedDocument'
import * as exportFile from '@/lib/exportFile'
import type { StrippedContent } from '@margin/pdf-core'

const save = vi.fn()

vi.mock('@/workers/pdfClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/workers/pdfClient')>()
  return { ...actual, getPdfClient: () => ({ save }) }
})

vi.mock('@/lib/fonts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fonts')>()
  return { ...actual, fontsForExport: vi.fn(async () => new Map()) }
})

const NOTHING: StrippedContent = {
  openAction: false, documentJavaScript: false, catalogActions: false, pageActions: 0,
  annotationActions: 0,
}

/** Make save() report `found`, as the worker does. */
function reports(found: StrippedContent): void {
  save.mockImplementation(
    async (
      _d: unknown,
      _f: unknown,
      _p: unknown,
      onStripped?: (f: StrippedContent) => void,
    ) => {
      onStripped?.(found)
      return new Uint8Array([1])
    },
  )
}

async function download() {
  const w = mount(TopBar)
  await w.get('[data-download]').trigger('click')
  await flushPromises()
  return w
}

describe('stripped-content notice', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.spyOn(exportFile, 'downloadBytes').mockImplementation(() => {})
    seedPages(3)
    useEditsStore()
  })

  it('says nothing for a clean document', async () => {
    reports(NOTHING)
    const w = await download()
    expect(w.find('[data-stripped-notice]').exists()).toBe(false)
  })

  it('says something when active content was removed', async () => {
    reports({ ...NOTHING, openAction: true })
    const w = await download()
    expect(w.get('[data-stripped-notice]').text()).toContain('Removed')
  })

  // "Some content was removed" tells the user nothing they can judge.
  it('names what it removed rather than being vague', async () => {
    reports({ ...NOTHING, openAction: true, documentJavaScript: true })
    const text = (await download()).get('[data-stripped-notice]').text()
    expect(text).toContain('run when the file opened')
    expect(text).toContain('document-level JavaScript')
  })

  it('mentions page actions when only those were found', async () => {
    reports({ ...NOTHING, pageActions: 3 })
    expect((await download()).get('[data-stripped-notice]').text()).toContain('page actions')
  })

  // The cost of stripping is real and belongs in front of the user.
  it('warns that form-field scripts are gone too', async () => {
    reports({ ...NOTHING, openAction: true })
    expect((await download()).get('[data-stripped-notice]').text()).toContain('form-field scripts')
  })

  it('can be dismissed', async () => {
    reports({ ...NOTHING, openAction: true })
    const w = await download()
    await w.get('[data-stripped-dismiss]').trigger('click')
    expect(w.find('[data-stripped-notice]').exists()).toBe(false)
  })

  // A stale notice from a previous file would be a lie about this one.
  it('clears the notice when a new download starts', async () => {
    reports({ ...NOTHING, openAction: true })
    const w = await download()
    expect(w.find('[data-stripped-notice]').exists()).toBe(true)
    reports(NOTHING)
    await w.get('[data-download]').trigger('click')
    await flushPromises()
    expect(w.find('[data-stripped-notice]').exists()).toBe(false)
  })

  it('does not block the download', async () => {
    reports({ ...NOTHING, openAction: true })
    await download()
    expect(exportFile.downloadBytes).toHaveBeenCalledTimes(1)
  })

  // Annotations are where /Launch actually lives, and a file whose only
  // payload is there used to be reported as clean.
  it('names removed annotation actions', async () => {
    reports({ ...NOTHING, annotationActions: 1 })
    expect((await download()).get('[data-stripped-notice]').text())
      .toContain('a link or field that would have run a file')
  })

  it('counts them when there is more than one', async () => {
    reports({ ...NOTHING, annotationActions: 4 })
    expect((await download()).get('[data-stripped-notice]').text()).toContain('4 links or fields')
  })

  // The notice condition lived inline in TopBar and drifted from the
  // sanitizer's own idea of "anything stripped" the moment a vector was
  // added. It asks pdf-core now; this is the regression test for that.
  it('shows for a vector the component does not name individually', async () => {
    reports({ ...NOTHING, annotationActions: 2 })
    expect((await download()).find('[data-stripped-notice]').exists()).toBe(true)
  })
})