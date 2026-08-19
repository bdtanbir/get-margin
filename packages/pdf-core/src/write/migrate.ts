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
 * v1 -> v2. v1 had one implicit source named by a top-level `sourceHash`,
 * and pages carried only a `sourceIndex`. v2 names the source explicitly so
 * merge can add more, and gives every page its rotation and crop overrides.
 */
function toV2(doc: V1): Record<string, unknown> {
  if (!isRecord(doc.pages) || !Array.isArray(doc.pageOrder)) {
    throw new Error('That is not an edit document.')
  }
  return {
    version: 2,
    sources: { [LEGACY_SOURCE_ID]: { hash: doc.sourceHash ?? '', name: '' } },
    pageOrder: [...doc.pageOrder],
    pages: Object.fromEntries(
      Object.entries(doc.pages).map(([id, p]) => [
        id,
        { sourceId: LEGACY_SOURCE_ID, sourceIndex: p.sourceIndex, rotation: 0, cropBox: null },
      ]),
    ),
    objects: { ...doc.objects },
    nextZ: doc.nextZ,
  }
}

/**
 * v2 -> v3. Forms.
 *
 * Both defaults mean "a document with no forms behaves exactly as it did",
 * which is what makes this safe to apply to every autosave record ever
 * written -- the step can neither change what a stored document exports nor
 * fail on one.
 */
function toV3(doc: Record<string, unknown>): Record<string, unknown> {
  return { ...doc, version: 3, fieldValues: {}, flattenForms: false }
}

/**
 * Lift a stored edit document to the schema this build understands.
 *
 * A pure function of its input; never mutates what it is given. Applied one
 * version at a time rather than as a set of special cases, so a v1 document
 * reaches v3 through the same v2 step a v2 document was written by -- there
 * is one path per version boundary, not one per pair of versions.
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

  let doc: Record<string, unknown> = input
  if (doc.version === 1) doc = toV2(doc as unknown as V1)
  if (doc.version === 2) doc = toV3(doc)

  return doc as unknown as EditDocument
}
