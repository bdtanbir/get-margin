import Dexie, { type Table } from 'dexie'

export type SavedSignature = {
  id?: number
  /** PNG bytes with a transparent background. */
  data: Uint8Array
  width: number
  height: number
  createdAt: number
}

/**
 * Saved signatures, on this device only.
 *
 * PERSISTENCE IS OPT-IN AND NOTHING HERE IS CALLED WITHOUT IT (spec 2.1).
 * A signature is sensitive personal data: a user who signs one document on
 * a shared or borrowed machine must not silently leave their signature in
 * its browser storage. The modal's checkbox is unchecked by default, and
 * `save()` is reached only from that checked path.
 */
class SignatureDb extends Dexie {
  signatures!: Table<SavedSignature, number>

  constructor() {
    super('get-margin-signatures')
    this.version(1).stores({ signatures: '++id, createdAt' })
  }
}

let db: SignatureDb | undefined

/** Constructed lazily so a session that never opts in never opens IndexedDB. */
function database(): SignatureDb {
  db ??= new SignatureDb()
  return db
}

export async function listSignatures(): Promise<SavedSignature[]> {
  try {
    return await database().signatures.orderBy('createdAt').reverse().toArray()
  } catch {
    // Private browsing and storage-blocked contexts reject IndexedDB. Losing
    // the saved list is not a reason to break signing.
    return []
  }
}

export async function saveSignature(
  sig: Omit<SavedSignature, 'id' | 'createdAt'>,
  createdAt: number,
): Promise<void> {
  try {
    await database().signatures.add({ ...sig, createdAt })
  } catch {
    // Same rationale: the signature is already placed on the page. Failing
    // to ALSO remember it must not fail the placement.
  }
}

export async function deleteSignature(id: number): Promise<void> {
  try {
    await database().signatures.delete(id)
  } catch {
    // Nothing to surface: the list re-reads and will show what survived.
  }
}

/** Forget every saved signature. Offered in the modal as a plain escape. */
export async function clearSignatures(): Promise<void> {
  try {
    await database().signatures.clear()
  } catch {
    // As above.
  }
}
