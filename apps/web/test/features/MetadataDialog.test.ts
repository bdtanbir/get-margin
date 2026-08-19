import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import MetadataDialog from '@/features/metadata/MetadataDialog.vue'
import { useEditsStore } from '@/stores/edits'
import type { DocumentMetadata } from '@margin/pdf-core'

const metadata = vi.fn<() => Promise<DocumentMetadata>>()
vi.mock('@/workers/pdfClient', () => ({
  getPdfClient: () => ({ metadata }),
  closeSharedDocument: vi.fn(),
}))

const SOURCE: DocumentMetadata = {
  title: 'Original title', author: 'Someone Else', subject: 'S', keywords: 'k', creator: 'Word',
}

function seed() {
  const edits = useEditsStore()
  edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
    { p1: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null } })
  return edits
}

async function open() {
  const w = mount(MetadataDialog)
  await flushPromises()
  return w
}

const value = (w: Awaited<ReturnType<typeof open>>, key: string) =>
  (w.get(`[data-metadata-field="${key}"]`).element as HTMLInputElement).value

describe('MetadataDialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    metadata.mockResolvedValue({ ...SOURCE })
    seed()
  })

  it('opens on what the document already says', async () => {
    const w = await open()
    expect(value(w, 'title')).toBe('Original title')
    expect(value(w, 'author')).toBe('Someone Else')
  })

  it('saves an edit to the store', async () => {
    const edits = seed()
    const w = await open()
    await w.get('[data-metadata-field="title"]').setValue('New title')
    await w.get('[data-metadata-apply]').trigger('click')
    expect(edits.doc.metadata?.title).toBe('New title')
    expect(w.emitted('close')).toBeTruthy()
  })

  it('is undoable', async () => {
    const edits = seed()
    const w = await open()
    await w.get('[data-metadata-field="title"]').setValue('New title')
    await w.get('[data-metadata-apply]').trigger('click')
    edits.undo()
    expect(edits.doc.metadata).toBeUndefined()
  })

  /**
   * Reading over an edit already made in this session would silently
   * discard what the user typed the moment they reopened the dialog.
   */
  it('shows the user’s pending edit rather than re-reading the file', async () => {
    const edits = seed()
    edits.applyOp({
      type: 'setMetadata',
      metadata: { ...SOURCE, title: 'Edited earlier' },
    }, 'Edit')
    const w = await open()
    expect(value(w, 'title')).toBe('Edited earlier')
    expect(metadata).not.toHaveBeenCalled()
  })

  it('survives a document whose details cannot be read', async () => {
    metadata.mockRejectedValue(new Error('no'))
    const w = await open()
    expect(value(w, 'title')).toBe('')
    expect(w.find('[data-metadata-apply]').exists()).toBe(true)
  })

  it('cancels without saving', async () => {
    const edits = seed()
    const w = await open()
    await w.get('[data-metadata-field="title"]').setValue('Not saved')
    await w.get('[data-metadata-cancel]').trigger('click')
    expect(edits.doc.metadata).toBeUndefined()
  })
})

describe('removing all details', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    metadata.mockResolvedValue({ ...SOURCE })
    seed()
  })

  it('sets the strip flag', async () => {
    const edits = seed()
    const w = await open()
    await w.get('[data-metadata-strip]').trigger('click')
    expect(edits.doc.stripMetadata).toBe(true)
  })

  /**
   * Undefined means "leave the source's own description alone" -- a
   * different state from "set every field to empty". Clearing it alongside
   * the flag keeps the two from contradicting each other at export.
   */
  it('clears any pending description', async () => {
    const edits = seed()
    edits.applyOp({ type: 'setMetadata', metadata: { ...SOURCE } }, 'Edit')
    const w = await open()
    await w.get('[data-metadata-strip]').trigger('click')
    expect(edits.doc.metadata).toBeUndefined()
  })

  it('is one undo, not two', async () => {
    const edits = seed()
    edits.clearHistory()
    const w = await open()
    await w.get('[data-metadata-strip]').trigger('click')
    expect(edits.historySize).toBe(1)
    edits.undo()
    // Undo restores the key's ABSENCE, not `false` -- stripMetadata is
    // optional and was never set, so the inverse patch removes it. Both
    // read as "do not strip"; asserting the exact prior state is what makes
    // this an undo test rather than a coincidence.
    expect(edits.doc.stripMetadata).toBeUndefined()
  })

  it('says so when the dialog is reopened', async () => {
    const edits = seed()
    edits.applyOp({ type: 'setStripMetadata', strip: true }, 'Remove')
    const w = await open()
    expect(w.find('[data-metadata-stripping]').exists()).toBe(true)
  })

  // Saving a description and asking for everything to be stripped are
  // contradictory; choosing one clears the other.
  it('saving afterwards cancels the removal', async () => {
    const edits = seed()
    edits.applyOp({ type: 'setStripMetadata', strip: true }, 'Remove')
    const w = await open()
    await w.get('[data-metadata-field="title"]').setValue('Kept')
    await w.get('[data-metadata-apply]').trigger('click')
    expect(edits.doc.stripMetadata).toBe(false)
    expect(edits.doc.metadata?.title).toBe('Kept')
  })

  // "Metadata" is a word about PDFs; what is being removed is who made the
  // file and when, plus the identifier that links it to other versions.
  it('says what removal actually costs', async () => {
    expect((await open()).text()).toMatch(/creation date and its identifier/i)
  })
})
