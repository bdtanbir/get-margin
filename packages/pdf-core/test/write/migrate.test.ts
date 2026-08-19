import { describe, it, expect } from 'vitest'
import { migrateEditDocument, LEGACY_SOURCE_ID } from '../../src/write/migrate.js'
import { EDIT_DOCUMENT_VERSION } from '../../src/write/types.js'

const v1 = {
  version: 1,
  sourceHash: 'abc123',
  pageOrder: ['p0', 'p1'],
  pages: { p0: { sourceIndex: 0 }, p1: { sourceIndex: 1 } },
  objects: {},
  nextZ: 1,
}

describe('migrateEditDocument', () => {
  it('lifts a v1 document to the current version', () => {
    expect(migrateEditDocument(v1).version).toBe(EDIT_DOCUMENT_VERSION)
  })

  it('synthesises one source from the old top-level hash', () => {
    const out = migrateEditDocument(v1)
    expect(Object.keys(out.sources)).toEqual([LEGACY_SOURCE_ID])
    expect(out.sources[LEGACY_SOURCE_ID]!.hash).toBe('abc123')
  })

  it('stamps every page with that source and default overrides', () => {
    const out = migrateEditDocument(v1)
    expect(out.pages.p0).toEqual({
      sourceId: LEGACY_SOURCE_ID, sourceIndex: 0, rotation: 0, cropBox: null,
    })
  })

  it('preserves page order and objects untouched', () => {
    const withObject = { ...v1, objects: { o1: { id: 'o1', pageId: 'p0' } } }
    const out = migrateEditDocument(withObject as never)
    expect(out.pageOrder).toEqual(['p0', 'p1'])
    expect(out.objects.o1).toBeDefined()
  })

  it('does not mutate its input', () => {
    const input = structuredClone(v1)
    migrateEditDocument(input)
    expect(input).toEqual(v1)
  })

  it('returns a v2 document unchanged', () => {
    const v2 = migrateEditDocument(v1)
    expect(migrateEditDocument(v2)).toEqual(v2)
  })

  // A newer schema must fail loudly rather than being silently mangled --
  // the same rule replay() already applies to the version field.
  it('refuses a version it does not understand', () => {
    expect(() => migrateEditDocument({ ...v1, version: 99 })).toThrow(/newer version/i)
  })

  it('refuses input that is not an edit document at all', () => {
    expect(() => migrateEditDocument(null)).toThrow()
    expect(() => migrateEditDocument({ nope: true })).toThrow()
    expect(() => migrateEditDocument({ version: 1 })).toThrow()
  })
})
