import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import RestorePrompt from '@/features/document/RestorePrompt.vue'
import { useAutosaveStore } from '@/stores/autosave'
import { useEditsStore } from '@/stores/edits'
import { useDocumentStore } from '@/stores/document'
import { seedPages } from '../helpers/seedDocument'
import { EDIT_DOCUMENT_VERSION } from '@margin/pdf-core'

const findEdit = vi.fn((_hash: string): Promise<unknown> => Promise.resolve(undefined))
const deleteEdit = vi.fn(async (_hash: string) => {})

vi.mock('@/lib/autosaveDb', () => ({
  putEdit: async () => {},
  findEdit: (hash: string) => findEdit(hash),
  deleteEdit: (hash: string) => deleteEdit(hash),
  pruneEdits: async () => {},
  clearEdits: async () => {},
  RETENTION_MS: 1,
  MAX_RECORDS: 20,
}))

const rect = (id: string) => ({
  id, pageId: 'p0', kind: 'rect' as const,
  rect: { x: 0, y: 0, w: 10, h: 10 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  stroke: [0, 0, 0] as [number, number, number], strokeWidth: 1, fill: null,
})

/** A stored record at the current schema, carrying one object. */
function record(savedAt = Date.now() - 5 * 60_000, version = EDIT_DOCUMENT_VERSION) {
  return {
    hash: 'h',
    name: 'a.pdf',
    savedAt,
    doc: {
      version,
      sources: { 'src-0': { hash: 'h', name: 'a.pdf' } },
      pageOrder: ['p0'],
      pages: { p0: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null } },
      objects: { o1: rect('o1') },
      nextZ: 2,
    },
  }
}

describe('RestorePrompt', () => {
  let autosave: ReturnType<typeof useAutosaveStore>
  let edits: ReturnType<typeof useEditsStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    seedPages(1)
    autosave = useAutosaveStore()
    edits = useEditsStore()
  })

  it('shows nothing when there are no stored edits', async () => {
    findEdit.mockResolvedValue(undefined)
    await autosave.checkForSaved()
    expect(mount(RestorePrompt).find('[data-restore-prompt]').exists()).toBe(false)
  })

  // NEVER silently: a user who deliberately started over would find their
  // old annotations back with no explanation.
  it('offers rather than restoring automatically', async () => {
    findEdit.mockResolvedValue(record())
    await autosave.checkForSaved()
    const w = mount(RestorePrompt)
    expect(w.find('[data-restore-prompt]').exists()).toBe(true)
    expect(edits.doc.objects).toEqual({})
  })

  it('says when the edits were made', async () => {
    findEdit.mockResolvedValue(record(Date.now() - 5 * 60_000))
    await autosave.checkForSaved()
    expect(mount(RestorePrompt).text()).toContain('5 minutes ago')
  })

  it('says the file itself was never stored', async () => {
    findEdit.mockResolvedValue(record())
    await autosave.checkForSaved()
    expect(mount(RestorePrompt).text()).toContain('never uploaded or stored')
  })

  it('applies the stored edits on accept', async () => {
    findEdit.mockResolvedValue(record())
    await autosave.checkForSaved()
    const w = mount(RestorePrompt)
    await w.get('[data-restore-accept]').trigger('click')
    expect(Object.keys(edits.doc.objects)).toEqual(['o1'])
    expect(w.find('[data-restore-prompt]').exists()).toBe(false)
  })

  // Undoing a restore would leave the user between two documents with no
  // way to say which one they meant.
  it('leaves no undo step behind after restoring', async () => {
    findEdit.mockResolvedValue(record())
    await autosave.checkForSaved()
    await mount(RestorePrompt).get('[data-restore-accept]').trigger('click')
    expect(edits.canUndo).toBe(false)
  })

  it('discards the record on discard, leaving a clean document', async () => {
    findEdit.mockResolvedValue(record())
    await autosave.checkForSaved()
    const w = mount(RestorePrompt)
    await w.get('[data-restore-discard]').trigger('click')
    expect(deleteEdit).toHaveBeenCalledWith('h')
    expect(edits.doc.objects).toEqual({})
  })

  it('"not now" keeps the record for next time', async () => {
    findEdit.mockResolvedValue(record())
    await autosave.checkForSaved()
    const w = mount(RestorePrompt)
    await w.get('[data-restore-dismiss]').trigger('click')
    expect(deleteEdit).not.toHaveBeenCalled()
    expect(w.find('[data-restore-prompt]').exists()).toBe(false)
  })

  // A record written by an older build must still restore.
  it('migrates an older stored schema', async () => {
    findEdit.mockResolvedValue({
      hash: 'h',
      name: 'a.pdf',
      savedAt: Date.now(),
      doc: {
        version: 1,
        sourceHash: 'h',
        pageOrder: ['p0'],
        pages: { p0: { sourceIndex: 0 } },
        objects: { o1: rect('o1') },
        nextZ: 2,
      },
    })
    await autosave.checkForSaved()
    await mount(RestorePrompt).get('[data-restore-accept]').trigger('click')
    expect(Object.keys(edits.doc.objects)).toEqual(['o1'])
  })

  // Silently restoring a document this build cannot represent would corrupt
  // the user's work rather than lose it, which is worse.
  it('refuses a record from a newer build and says so', async () => {
    findEdit.mockResolvedValue(record(Date.now(), 99))
    await autosave.checkForSaved()
    await mount(RestorePrompt).get('[data-restore-accept]').trigger('click')
    expect(useDocumentStore().error).toMatch(/newer version/i)
    expect(edits.doc.objects).toEqual({})
  })
})
