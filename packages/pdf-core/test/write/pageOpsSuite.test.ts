import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import * as mupdf from 'mupdf'
import { replay, WRITERS } from '../../src/write/index.js'
import {
  EDIT_DOCUMENT_VERSION, type EditDocument, type ObjectKind,
} from '../../src/write/types.js'
import { PdfDocument } from '../../src/index.js'
import { assertGolden } from '../golden.js'
import { generateFixtures, fixturePath, type FixtureName } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: FixtureName): Uint8Array => new Uint8Array(readFileSync(fixturePath(n)))

const A = 'src-a'
const B = 'src-b'

/**
 * Rotate + crop + reorder + delete in one document, exercised on whichever
 * fixture is passed. Placement is a FRACTION of the page's own box so the
 * same edit is meaningful on a Letter page and on the 350x420
 * offset-CropBox page.
 */
function pageOps(fixture: FixtureName): EditDocument {
  const doc = PdfDocument.open(bytes(fixture))
  let geometry
  let pageCount = 0
  try {
    geometry = doc.pageGeometry(0)
    pageCount = doc.pageCount
  } finally { doc.close() }

  const [x0, y0, x1, y1] = geometry.cropBox
  const pw = x1 - x0
  const ph = y1 - y0

  // Take up to four pages, then reverse them and drop the last -- so the
  // export exercises reorder AND delete at once.
  const take = Math.min(4, pageCount)
  const chosen = Array.from({ length: take }, (_, i) => i).reverse().slice(0, Math.max(1, take - 1))

  return {
    version: EDIT_DOCUMENT_VERSION,
    sources: { [A]: { hash: '', name: 'a.pdf' } },
    pageOrder: chosen.map((i) => `p${i}`),
    pages: Object.fromEntries(chosen.map((sourceIndex, position) => [
      `p${sourceIndex}`,
      {
        sourceId: A,
        sourceIndex,
        // First page rotated a quarter turn; second cropped to its TOP half.
        //
        // The top half specifically, because that is where these fixtures
        // put their text: a correct crop renders the label, a vertically
        // mirrored one renders a blank band. That makes the golden a mirror
        // detector rather than just a picture.
        rotation: position === 0 ? 90 : 0,
        cropBox: position === 1
          ? [x0 + pw * 0.1, y0 + ph * 0.5, x0 + pw * 0.9, y0 + ph] as [number, number, number, number]
          : null,
      },
    ])),
    objects: {},
    nextZ: 1,
  }
}

/** One page from each of two sources, the merged case. */
function merged(): EditDocument {
  return {
    version: EDIT_DOCUMENT_VERSION,
    sources: { [A]: { hash: '', name: 'a.pdf' }, [B]: { hash: '', name: 'b.pdf' } },
    pageOrder: ['m0', 'm1'],
    pages: {
      m0: { sourceId: B, sourceIndex: 0, rotation: 0, cropBox: null },
      m1: { sourceId: A, sourceIndex: 1, rotation: 90, cropBox: null },
    },
    objects: {},
    nextZ: 1,
  }
}

function pageCount(pdf: Uint8Array): number {
  const d = PdfDocument.open(pdf)
  try { return d.pageCount } finally { d.close() }
}

function annotsOf(pdf: Uint8Array, i = 0) {
  const d = PdfDocument.open(pdf)
  try {
    const p = d._raw().loadPage(i)
    try {
      return {
        annots: p.getAnnotations().map((a) => a.getType()),
        links: p.getLinks().map((l) => l.getURI()),
      }
    } finally { p.destroy() }
  } finally { d.close() }
}

/** A source whose first page already carries an ink annotation and a link. */
function annotated(fixture: FixtureName): Uint8Array {
  const raw = mupdf.PDFDocument.openDocument(
    bytes(fixture),
    'application/pdf',
  ) as mupdf.PDFDocument
  const page = raw.loadPage(0)
  const a = page.createAnnotation('Ink')
  a.setColor([1, 0, 0])
  a.setBorderWidth(3)
  a.setInkList([[[100, 100], [200, 150], [300, 100]]])
  a.update()
  page.createLink([100, 100, 300, 130], 'https://example.com/')
  const out = raw.saveToBuffer('compress,garbage=compact').asUint8Array()
  page.destroy()
  raw.destroy()
  return out
}

const FIXTURES: FixtureName[] = ['simple-text', 'offset-cropbox', 'rotated', 'multi-page']

describe('Phase 3 page-operation suite', () => {
  // Re-run here because the schema change touched the write path: a kind
  // losing its writer would only surface at export time, in front of a user.
  it('still registers a writer for every ObjectKind', () => {
    const kinds: ObjectKind[] = [
      'text', 'image', 'rect', 'ellipse', 'line', 'arrow',
      'ink', 'highlight', 'underline', 'strikeout',
      'whiteout', 'link', 'signature',
    ]
    for (const kind of kinds) expect(WRITERS[kind], `no writer for "${kind}"`).toBeDefined()
  })

  it.each(FIXTURES)('applies rotate, crop, reorder and delete to %s', (fixture) => {
    const editDoc = pageOps(fixture)
    const out = replay(new Map([[A, bytes(fixture)]]), editDoc)
    expect(pageCount(out)).toBe(editDoc.pageOrder.length)
  })

  it.each(FIXTURES)('matches the reviewed golden for %s', async (fixture) => {
    await assertGolden(
      `pageops-${fixture}`,
      replay(new Map([[A, bytes(fixture)]]), pageOps(fixture)),
      { page: 0 },
    )
  })

  // The crop lands on the SECOND page of the edit, so none of the goldens
  // above render it. A mirrored crop is the failure mode this phase guards
  // against and it looks entirely plausible, so it gets its own image.
  it('matches the reviewed golden for a cropped page', async () => {
    await assertGolden(
      'pageops-cropped',
      replay(new Map([[A, bytes('multi-page')]]), pageOps('multi-page')),
      { page: 1 },
    )
  })

  it('matches the reviewed golden for a two-source merge', async () => {
    await assertGolden(
      'pageops-merged',
      replay(new Map([[A, bytes('multi-page')], [B, bytes('simple-text')]]), merged()),
      { page: 1 },
    )
  })

  // Export is a pure function of (sources, EditDocument).
  it.each(FIXTURES)('is deterministic and leaves the source untouched for %s', (fixture) => {
    const src = bytes(fixture)
    const before = src.slice()
    const editDoc = pageOps(fixture)
    const a = replay(new Map([[A, src]]), editDoc)
    const b = replay(new Map([[A, src]]), editDoc)
    expect(src).toEqual(before)
    expect(a.byteLength).toBe(b.byteLength)
  })

  // The regression the whole phase turns on: graftPage drops /Annots, so a
  // merge built naively destroys the annotations already in the user's file.
  it('keeps existing annotations through every page operation', () => {
    const out = replay(new Map([[A, annotated('multi-page')]]), {
      ...pageOps('multi-page'),
      // Put the annotated source page (0) last, so it also survives a move.
      pageOrder: ['p1', 'p0'],
      pages: {
        p1: { sourceId: A, sourceIndex: 1, rotation: 90, cropBox: null },
        p0: { sourceId: A, sourceIndex: 0, rotation: 0, cropBox: null },
      },
    })
    expect(annotsOf(out, 1)).toEqual({ annots: ['Ink'], links: ['https://example.com/'] })
  })

  it('keeps existing annotations through a merge', () => {
    const out = replay(
      new Map([[A, annotated('multi-page')], [B, bytes('simple-text')]]),
      {
        version: EDIT_DOCUMENT_VERSION,
        sources: { [A]: { hash: '', name: 'a.pdf' }, [B]: { hash: '', name: 'b.pdf' } },
        pageOrder: ['x', 'y'],
        pages: {
          x: { sourceId: B, sourceIndex: 0, rotation: 0, cropBox: null },
          y: { sourceId: A, sourceIndex: 0, rotation: 0, cropBox: null },
        },
        objects: {},
        nextZ: 1,
      },
    )
    expect(annotsOf(out, 1)).toEqual({ annots: ['Ink'], links: ['https://example.com/'] })
  })

  it('produces a reopenable document for every fixture', () => {
    for (const fixture of FIXTURES) {
      const out = replay(new Map([[A, bytes(fixture)]]), pageOps(fixture))
      expect(pageCount(out)).toBeGreaterThan(0)
    }
  })
})
