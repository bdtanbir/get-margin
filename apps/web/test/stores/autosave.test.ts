import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAutosaveStore, AUTOSAVE_DEBOUNCE_MS } from '@/stores/autosave'
import { useEditsStore } from '@/stores/edits'
import { useDocumentStore } from '@/stores/document'
import { seedPages } from '../helpers/seedDocument'
import type { EditObject } from '@margin/pdf-core'

type Rec = { hash: string; name: string; savedAt: number; doc: { objects: Record<string, unknown> } }

const putEdit = vi.fn(async (_record: Rec) => {})
const findEdit = vi.fn(async (_hash: string): Promise<Rec | undefined> => undefined)
const deleteEdit = vi.fn(async (_hash: string) => {})

vi.mock('@/lib/autosaveDb', () => ({
  putEdit: (record: Rec) => putEdit(record),
  findEdit: (hash: string) => findEdit(hash),
  deleteEdit: (hash: string) => deleteEdit(hash),
  pruneEdits: async () => {},
  clearEdits: async () => {},
  RETENTION_MS: 1,
  MAX_RECORDS: 20,
}))

function rect(id: string): EditObject {
  return {
    id, pageId: 'p0', kind: 'rect',
    rect: { x: 0, y: 0, w: 10, h: 10 },
    rotation: 0, z: 1, locked: false, opacity: 1,
    stroke: [0, 0, 0], strokeWidth: 1, fill: null,
  }
}

describe('useAutosaveStore', () => {
  let edits: ReturnType<typeof useEditsStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.useFakeTimers()
    seedPages(2)
    edits = useEditsStore()
  })

  afterEach(() => {
    useAutosaveStore().stop()
    vi.useRealTimers()
  })

  // An autosave per keystroke is a write per keystroke.
  it('coalesces a burst of edits into one write', async () => {
    const store = useAutosaveStore()
    store.start()
    for (let i = 0; i < 20; i++) {
      edits.applyOp({ type: 'addObject', object: rect(`o${i}`) }, 'Draw')
    }
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2)
    expect(putEdit).toHaveBeenCalledTimes(1)
  })

  it('waits for the debounce before writing at all', async () => {
    const store = useAutosaveStore()
    store.start()
    edits.applyOp({ type: 'addObject', object: rect('o1') }, 'Draw')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 100)
    expect(putEdit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(putEdit).toHaveBeenCalledTimes(1)
  })

  it('writes the current edit document, keyed by the primary source hash', async () => {
    const store = useAutosaveStore()
    store.start()
    edits.applyOp({ type: 'addObject', object: rect('o1') }, 'Draw')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2)
    const record = putEdit.mock.calls[0]![0]
    expect(record.hash).toBe('h')
    expect(record.name).toBe('a.pdf')
    expect(Object.keys(record.doc.objects)).toEqual(['o1'])
  })

  it('records when it last saved', async () => {
    const store = useAutosaveStore()
    store.start()
    edits.applyOp({ type: 'addObject', object: rect('o1') }, 'Draw')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2)
    expect(store.lastSavedAt).toBeGreaterThan(0)
  })

  it('does not write when no document is open', async () => {
    const doc = useDocumentStore()
    doc.$patch({ status: 'empty', sourceHash: '' })
    const store = useAutosaveStore()
    store.start()
    edits.applyOp({ type: 'addObject', object: rect('o1') }, 'Draw')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2)
    expect(putEdit).not.toHaveBeenCalled()
  })

  // beforeunload: a deliberate close should keep the last edit.
  it('flush() writes immediately without waiting for the debounce', async () => {
    const store = useAutosaveStore()
    store.start()
    edits.applyOp({ type: 'addObject', object: rect('o1') }, 'Draw')
    await store.flush()
    expect(putEdit).toHaveBeenCalledTimes(1)
  })

  it('stop() cancels a pending write', async () => {
    const store = useAutosaveStore()
    store.start()
    edits.applyOp({ type: 'addObject', object: rect('o1') }, 'Draw')
    store.stop()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2)
    expect(putEdit).not.toHaveBeenCalled()
  })

  it('start() twice does not double-subscribe', async () => {
    const store = useAutosaveStore()
    store.start()
    store.start()
    edits.applyOp({ type: 'addObject', object: rect('o1') }, 'Draw')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2)
    expect(putEdit).toHaveBeenCalledTimes(1)
  })

  // A failed save must not take the editor down with it.
  it('survives a rejected write', async () => {
    putEdit.mockRejectedValueOnce(new Error('storage blocked'))
    const store = useAutosaveStore()
    store.start()
    edits.applyOp({ type: 'addObject', object: rect('o1') }, 'Draw')
    await expect(vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2)).resolves.not.toThrow()
  })

  describe('finding saved edits', () => {
    it('offers nothing when there is no stored record', async () => {
      const store = useAutosaveStore()
      await store.checkForSaved()
      expect(store.offered).toBeUndefined()
    })

    it('offers a matching record without applying it', async () => {
      findEdit.mockResolvedValueOnce({ hash: 'h', name: 'a.pdf', savedAt: 1, doc: { objects: { o9: {} } } })
      const store = useAutosaveStore()
      await store.checkForSaved()
      expect(store.offered).toBeDefined()
      // NEVER silently: a user who started over would find old work back.
      expect(edits.doc.objects).toEqual({})
    })

    it('discard() deletes the record and clears the offer', async () => {
      findEdit.mockResolvedValueOnce({ hash: 'h', name: 'a.pdf', savedAt: 1, doc: { objects: {} } })
      const store = useAutosaveStore()
      await store.checkForSaved()
      await store.discard()
      expect(deleteEdit).toHaveBeenCalledWith('h')
      expect(store.offered).toBeUndefined()
    })

    it('dismiss() clears the offer but keeps the record', async () => {
      findEdit.mockResolvedValueOnce({ hash: 'h', name: 'a.pdf', savedAt: 1, doc: { objects: {} } })
      const store = useAutosaveStore()
      await store.checkForSaved()
      store.dismiss()
      expect(store.offered).toBeUndefined()
      expect(deleteEdit).not.toHaveBeenCalled()
    })
  })
})

// Caught by e2e first: discarding a restore re-saved the emptied document,
// so reopening the same file offered to restore nothing at all.
describe('nothing worth saving', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.useFakeTimers()
    seedPages(2)
  })

  afterEach(() => {
    useAutosaveStore().stop()
    vi.useRealTimers()
  })

  it('does not save a document with no objects and no history', async () => {
    const store = useAutosaveStore()
    store.start()
    await store.flush()
    expect(putEdit).not.toHaveBeenCalled()
  })

  it('saves once something has actually been edited', async () => {
    const edits = useEditsStore()
    const store = useAutosaveStore()
    store.start()
    edits.applyOp({ type: 'addObject', object: rect('o1') }, 'Draw')
    await store.flush()
    expect(putEdit).toHaveBeenCalledTimes(1)
  })

  // A page delete leaves no objects behind but is certainly worth keeping.
  it('saves a structural edit that leaves no objects', async () => {
    const edits = useEditsStore()
    const store = useAutosaveStore()
    store.start()
    edits.applyOp({ type: 'deletePages', pageIds: ['p1'] }, 'Delete')
    await store.flush()
    expect(putEdit).toHaveBeenCalledTimes(1)
  })
})
