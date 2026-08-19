import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import {
  putEdit, findEdit, deleteEdit, pruneEdits, clearEdits,
  RETENTION_MS, MAX_RECORDS, type SavedEdit,
} from '@/lib/autosaveDb'
import { emptyEditDocument, type EditDocument } from '@margin/pdf-core'

const NOW = 1_700_000_000_000

function editDoc(): EditDocument {
  return {
    ...emptyEditDocument(),
    sources: { 'src-0': { hash: 'h', name: 'a.pdf' } },
    pageOrder: ['p0'],
    pages: { p0: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null } },
  }
}

const record = (hash: string, savedAt: number): SavedEdit =>
  ({ hash, name: `${hash}.pdf`, savedAt, doc: editDoc() })

describe('autosaveDb', () => {
  beforeEach(async () => {
    await clearEdits()
  })

  it('round-trips an edit document by hash', async () => {
    await putEdit(record('h1', NOW))
    const back = await findEdit('h1')
    expect(back?.name).toBe('h1.pdf')
    expect(back?.doc.pageOrder).toEqual(['p0'])
  })

  it('overwrites the record for the same document rather than accumulating', async () => {
    await putEdit(record('h1', NOW))
    await putEdit(record('h1', NOW + 5))
    expect((await findEdit('h1'))!.savedAt).toBe(NOW + 5)
  })

  it('returns undefined for a document it has never seen', async () => {
    expect(await findEdit('nope')).toBeUndefined()
  })

  it('deletes a record', async () => {
    await putEdit(record('h1', NOW))
    await deleteEdit('h1')
    expect(await findEdit('h1')).toBeUndefined()
  })

  // Storage must not grow across every document the user has ever opened.
  it('prunes records older than the retention window', async () => {
    await putEdit(record('old', NOW - RETENTION_MS - 1))
    await putEdit(record('new', NOW))
    await pruneEdits(NOW)
    expect(await findEdit('old')).toBeUndefined()
    expect(await findEdit('new')).toBeDefined()
  })

  it('keeps a record right at the retention edge', async () => {
    await putEdit(record('edge', NOW - RETENTION_MS + 1000))
    await pruneEdits(NOW)
    expect(await findEdit('edge')).toBeDefined()
  })

  it('prunes the oldest first when over the record cap', async () => {
    for (let i = 0; i < MAX_RECORDS + 5; i++) await putEdit(record(`h${i}`, NOW + i))
    // putEdit prunes as it goes, so the five oldest are already gone.
    expect(await findEdit('h0')).toBeUndefined()
    expect(await findEdit(`h${MAX_RECORDS + 4}`)).toBeDefined()
  })

  // Private browsing and storage-blocked contexts reject IndexedDB. Losing
  // autosave is not a reason to break editing.
  //
  // Dexie is mocked rather than the environment broken: the handle is
  // cached lazily and `fake-indexeddb/auto` keeps reinstalling a working
  // one, so removing globalThis.indexedDB proved nothing -- the writes
  // still succeeded and the test passed without touching the fallback.
  it('degrades to a no-op when every storage call rejects', async () => {
    vi.resetModules()
    vi.doMock('dexie', () => {
      const boom = () => Promise.reject(new Error('storage blocked'))
      class FakeDexie {
        edits = {
          put: boom, get: boom, delete: boom, clear: boom, bulkDelete: boom,
          where: () => ({ below: () => ({ delete: boom }) }),
          orderBy: () => ({ reverse: () => ({ toArray: boom }) }),
        }
        version() { return { stores: () => undefined } }
      }
      return { default: FakeDexie }
    })
    try {
      const fresh = await import('@/lib/autosaveDb')
      await expect(fresh.putEdit(record('x', NOW))).resolves.toBeUndefined()
      await expect(fresh.findEdit('x')).resolves.toBeUndefined()
      await expect(fresh.deleteEdit('x')).resolves.toBeUndefined()
      await expect(fresh.pruneEdits(NOW)).resolves.toBeUndefined()
      await expect(fresh.clearEdits()).resolves.toBeUndefined()
    } finally {
      vi.doUnmock('dexie')
      vi.resetModules()
    }
  })
})
