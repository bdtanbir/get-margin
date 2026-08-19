import Dexie, { type Table } from 'dexie'
import type { EditDocument } from '@margin/pdf-core'

export type SavedEdit = {
  /** SHA-256 of the primary source. The key, so re-picking the file finds it. */
  hash: string
  name: string
  savedAt: number
  doc: EditDocument
}

/** Records older than this are dropped on the next write. */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** Hard cap on how many documents' edits are kept at once. */
export const MAX_RECORDS = 20

/**
 * Autosaved edits, on this device only.
 *
 * THE SOURCE PDF IS NOT STORED. Only the EditDocument -- geometry, colours,
 * text, and the already-capped image and signature payloads. The source can
 * be up to 150MB, and keeping a copy of every document the user has ever
 * opened is a privacy cost the "never leaves the browser" promise does not
 * license on its own. Restoring means re-picking the file; the hash is what
 * matches it back to its edits.
 */
class AutosaveDb extends Dexie {
  edits!: Table<SavedEdit, string>

  constructor() {
    super('get-margin-autosave')
    this.version(1).stores({ edits: 'hash, savedAt' })
  }
}

let db: AutosaveDb | undefined

/** Constructed lazily, so a session that never edits never opens IndexedDB. */
function database(): AutosaveDb {
  db ??= new AutosaveDb()
  return db
}

/**
 * Every call swallows failure. Private browsing and storage-blocked
 * contexts reject IndexedDB, and losing autosave is not a reason to break
 * editing -- the same rule signatureStore.ts already follows.
 */
export async function putEdit(record: SavedEdit): Promise<void> {
  try {
    await database().edits.put(record)
    await pruneEdits(record.savedAt)
  } catch {
    // Storage unavailable; the document is still fully editable.
  }
}

export async function findEdit(hash: string): Promise<SavedEdit | undefined> {
  try {
    return await database().edits.get(hash)
  } catch {
    return undefined
  }
}

export async function deleteEdit(hash: string): Promise<void> {
  try {
    await database().edits.delete(hash)
  } catch {
    // As above.
  }
}

/** Drop what is too old, then the oldest of whatever is left over the cap. */
export async function pruneEdits(now: number): Promise<void> {
  try {
    const table = database().edits
    await table.where('savedAt').below(now - RETENTION_MS).delete()

    const remaining = await table.orderBy('savedAt').reverse().toArray()
    const excess = remaining.slice(MAX_RECORDS)
    if (excess.length > 0) await table.bulkDelete(excess.map((r) => r.hash))
  } catch {
    // As above.
  }
}

export async function clearEdits(): Promise<void> {
  try {
    await database().edits.clear()
  } catch {
    // As above.
  }
}
