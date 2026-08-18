import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { replay, WRITERS } from '../../src/write/index.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument } from '../../src/write/types.js'
import { PdfDocument } from '../../src/index.js'
import { assertGolden } from '../golden.js'

import { generateFixtures, fixturePath, type FixtureName } from '../fixtures/index.js'

// Every pdf-core test bootstraps fixtures this way -- they are generated,
// not committed, so reading the path directly without this fails on a clean
// checkout. Matches test/golden.test.ts and test/render.test.ts.
beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: FixtureName): Uint8Array => new Uint8Array(readFileSync(fixturePath(n)))

function emptyEdits(pageCount: number): EditDocument {
  const pageOrder = Array.from({ length: pageCount }, (_, i) => `p${i}`)
  const pages = Object.fromEntries(pageOrder.map((id, i) => [id, { sourceIndex: i }]))
  return {
    version: EDIT_DOCUMENT_VERSION,
    sourceHash: '',
    pageOrder,
    pages,
    objects: {},
    nextZ: 1,
  }
}

describe('replay', () => {
  it('produces a document that still opens and keeps its page count', () => {
    const src = bytes('multi-page')
    // multi-page.pdf is 12 pages -- pinned by the existing
    // apps/web/test/workers/pdfService.test.ts, which asserts the same count.
    const out = replay(src, emptyEdits(12))
    const doc = PdfDocument.open(out)
    try {
      expect(doc.pageCount).toBe(12)
    } finally {
      doc.close()
    }
  })

  it('renders identically to the source when there are no objects', async () => {
    const src = bytes('simple-text')
    // Reuses the Phase 0 golden rig: same committed baseline the read path
    // is already checked against, so a write-path regression that alters
    // untouched pages fails here.
    await assertGolden('simple-text-p0', replay(src, emptyEdits(1)))
  })

  it('rejects an EditDocument written by a newer schema version', () => {
    const src = bytes('simple-text')
    const edits = { ...emptyEdits(1), version: EDIT_DOCUMENT_VERSION + 1 }
    expect(() => replay(src, edits)).toThrow(/version/i)
  })

  it('throws rather than silently skipping an unknown object kind', () => {
    const src = bytes('simple-text')
    const edits = emptyEdits(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    edits.objects.x1 = { id: 'x1', pageId: 'p0', kind: 'nope' } as any
    expect(() => replay(src, edits)).toThrow(/nope/)
  })

  it('throws when an object names a page the edit document does not define', () => {
    const src = bytes('simple-text')
    const edits = emptyEdits(1)
    edits.pageOrder.push('ghost')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    edits.objects.x1 = { id: 'x1', pageId: 'ghost', kind: 'rect', z: 1 } as any
    expect(() => replay(src, edits)).toThrow(/ghost/)
  })

  it('draws each page\'s objects in ascending z order', () => {
    // The stacking contract every writer from Task 29 on depends on. Uses a
    // throwaway writer so the order is observable without any real writer
    // existing yet.
    const src = bytes('simple-text')
    const edits = emptyEdits(1)
    for (const [id, z] of [['c', 30], ['a', 10], ['b', 20]] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      edits.objects[id] = { id, pageId: 'p0', kind: 'rect', z } as any
    }

    const seen: string[] = []
    const previous = WRITERS.rect
    WRITERS.rect = (_ctx, object) => { seen.push(object.id) }
    try {
      replay(src, edits)
    } finally {
      if (previous) WRITERS.rect = previous
      else delete WRITERS.rect
    }
    expect(seen).toEqual(['a', 'b', 'c'])
  })
})
