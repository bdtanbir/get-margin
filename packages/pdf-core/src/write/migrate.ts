import { EDIT_DOCUMENT_VERSION, type EditDocument, type SourceId } from './types.js'

/**
 * The source id given to a document that predates multi-source support.
 * Deterministic, so migrating the same v1 document twice produces the same
 * ids and a re-opened autosave does not orphan its pages.
 */
export const LEGACY_SOURCE_ID: SourceId = 'src-0'

type V1 = {
  version: 1
  sourceHash: string
  pageOrder: string[]
  pages: Record<string, { sourceIndex: number }>
  objects: Record<string, unknown>
  nextZ: number
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * v1 -> v2. A pure function of its input; never mutates what it is given.
 *
 * v1 had one implicit source named by a top-level `sourceHash`, and pages
 * carried only a `sourceIndex`. v2 names the source explicitly so merge can
 * add more, and gives every page its rotation and crop overrides.
 */
export function migrateEditDocument(input: unknown): EditDocument {
  if (!isRecord(input) || typeof input.version !== 'number') {
    throw new Error('That is not an edit document.')
  }
  if (input.version > EDIT_DOCUMENT_VERSION) {
    throw new Error(
      `This document was edited by a newer version of get-margin ` +
        `(schema version ${input.version}, this build understands ${EDIT_DOCUMENT_VERSION}).`,
    )
  }
  if (input.version === EDIT_DOCUMENT_VERSION) return input as unknown as EditDocument

  const doc = input as unknown as V1
  if (!isRecord(doc.pages) || !Array.isArray(doc.pageOrder)) {
    throw new Error('That is not an edit document.')
  }

  return {
    version: EDIT_DOCUMENT_VERSION,
    sources: { [LEGACY_SOURCE_ID]: { hash: doc.sourceHash ?? '', name: '' } },
    pageOrder: [...doc.pageOrder],
    pages: Object.fromEntries(
      Object.entries(doc.pages).map(([id, p]) => [
        id,
        { sourceId: LEGACY_SOURCE_ID, sourceIndex: p.sourceIndex, rotation: 0, cropBox: null },
      ]),
    ),
    objects: { ...doc.objects } as EditDocument['objects'],
    nextZ: doc.nextZ,
  }
}
