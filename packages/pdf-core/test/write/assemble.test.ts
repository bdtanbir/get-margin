import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import * as mupdf from 'mupdf'
import { replay } from '../../src/write/index.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument } from '../../src/write/types.js'
import { PdfDocument } from '../../src/index.js'
import { generateFixtures, fixturePath, type FixtureName } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: FixtureName): Uint8Array => new Uint8Array(readFileSync(fixturePath(n)))

const SRC = 'src-0'

/** An edit document over one source, listing pages in the given source order. */
function doc(order: number[]): EditDocument {
  return {
    version: EDIT_DOCUMENT_VERSION,
    sources: { [SRC]: { hash: '', name: 'a.pdf' } },
    pageOrder: order.map((i) => `p${i}`),
    pages: Object.fromEntries(order.map((i) => [
      `p${i}`,
      { sourceId: SRC, sourceIndex: i, rotation: 0, cropBox: null },
    ])),
    objects: {},
    nextZ: 1,
  }
}

function twoSources(pages: Array<{ id: string; sourceId: string; sourceIndex: number }>): EditDocument {
  return {
    version: EDIT_DOCUMENT_VERSION,
    sources: { a: { hash: '', name: 'a.pdf' }, b: { hash: '', name: 'b.pdf' } },
    pageOrder: pages.map((p) => p.id),
    pages: Object.fromEntries(pages.map((p) => [
      p.id,
      { sourceId: p.sourceId, sourceIndex: p.sourceIndex, rotation: 0, cropBox: null },
    ])),
    objects: {},
    nextZ: 1,
  }
}

function firstLine(pdf: Uint8Array, i: number): string {
  const d = PdfDocument.open(pdf)
  try {
    const p = d._raw().loadPage(i)
    try { return p.toStructuredText('').asText().trim().split('\n')[0] ?? '' } finally { p.destroy() }
  } finally { d.close() }
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

/**
 * A source whose FIRST page already carries an ink annotation and a link.
 *
 * The regression this guards is invisible with a plain fixture: Phase 2's
 * own objects are drawn from EditDocument after assembly, so they always
 * survive. It is the annotations that were ALREADY in the user's file that
 * graftPage destroys.
 */
function annotated(): Uint8Array {
  // openDocument is typed as returning the base Document; this fixture is
  // known to be a PDF, so the narrowing is safe and local to the test.
  const raw = mupdf.PDFDocument.openDocument(
    bytes('multi-page'),
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

describe('assembly', () => {
  // TIER 1. e2e/download.spec.ts asserts byte identity for an unedited
  // download, and that promise must survive the schema change.
  it('returns the original bytes when nothing changed', () => {
    const original = bytes('multi-page')
    const all = Array.from({ length: pageCount(original) }, (_, i) => i)
    const out = replay(new Map([[SRC, original]]), doc(all))
    expect(Array.from(out)).toEqual(Array.from(original))
  })

  it('does NOT pass through once a page is dropped', () => {
    const original = bytes('multi-page')
    const out = replay(new Map([[SRC, original]]), doc([0, 1, 2]))
    expect(Array.from(out)).not.toEqual(Array.from(original))
    expect(pageCount(out)).toBe(3)
  })

  // TIER 2.
  it('reorders a single source in the order given', () => {
    const out = replay(new Map([[SRC, bytes('multi-page')]]), doc([2, 0, 1]))
    expect(pageCount(out)).toBe(3)
    expect([0, 1, 2].map((i) => firstLine(out, i))).toEqual(['Page 3', 'Page 1', 'Page 2'])
  })

  it('extracts a subset', () => {
    const out = replay(new Map([[SRC, bytes('multi-page')]]), doc([4, 5]))
    expect(pageCount(out)).toBe(2)
    expect(firstLine(out, 0)).toBe('Page 5')
    expect(firstLine(out, 1)).toBe('Page 6')
  })

  it('can repeat a source page', () => {
    const out = replay(new Map([[SRC, bytes('multi-page')]]), doc([0, 0]))
    expect(pageCount(out)).toBe(2)
    expect(firstLine(out, 0)).toBe('Page 1')
    expect(firstLine(out, 1)).toBe('Page 1')
  })

  // The in-place tier exists BECAUSE it is lossless. If this fails, the
  // tier has silently become a graft.
  it('keeps existing annotations and links through a reorder', () => {
    const out = replay(new Map([[SRC, annotated()]]), doc([1, 0]))
    // The annotated page was source page 0, now at position 1.
    expect(annotsOf(out, 1)).toEqual({ annots: ['Ink'], links: ['https://example.com/'] })
  })

  // TIER 3. graftPage drops /Annots -- without the explicit re-graft this
  // fails and a real user loses their highlights on every merge.
  it('keeps existing annotations and links through a MERGE', () => {
    const out = replay(
      new Map([['a', annotated()], ['b', bytes('simple-text')]]),
      twoSources([
        { id: 'x', sourceId: 'a', sourceIndex: 0 },
        { id: 'y', sourceId: 'b', sourceIndex: 0 },
      ]),
    )
    expect(pageCount(out)).toBe(2)
    expect(annotsOf(out, 0)).toEqual({ annots: ['Ink'], links: ['https://example.com/'] })
  })

  it('merges pages from two sources in the given order', () => {
    const out = replay(
      new Map([['a', bytes('multi-page')], ['b', bytes('simple-text')]]),
      twoSources([
        { id: 's', sourceId: 'b', sourceIndex: 0 },
        { id: 'm1', sourceId: 'a', sourceIndex: 1 },
        { id: 'm2', sourceId: 'a', sourceIndex: 0 },
      ]),
    )
    expect(pageCount(out)).toBe(3)
    expect(firstLine(out, 0)).toContain('Hello margin')
    expect(firstLine(out, 1)).toBe('Page 2')
    expect(firstLine(out, 2)).toBe('Page 1')
  })

  it('opens each source once however many of its pages are used', () => {
    // Six pages from one source and one from another: a per-page open would
    // reparse the 12-page fixture six times. Correctness proxy: it works
    // and produces the right order.
    const out = replay(
      new Map([['a', bytes('multi-page')], ['b', bytes('simple-text')]]),
      twoSources([
        ...[0, 1, 2, 3, 4, 5].map((i) => ({ id: `a${i}`, sourceId: 'a', sourceIndex: i })),
        { id: 'z', sourceId: 'b', sourceIndex: 0 },
      ]),
    )
    expect(pageCount(out)).toBe(7)
    expect(firstLine(out, 6)).toContain('Hello margin')
  })

  it('throws by name when a page names a source that was not supplied', () => {
    expect(() => replay(new Map(), doc([0]))).toThrow(/src-0/)
  })

  it('throws when a page id has no entry', () => {
    const broken = doc([0])
    broken.pageOrder = ['ghost']
    expect(() => replay(new Map([[SRC, bytes('multi-page')]]), broken)).toThrow(/ghost/)
  })

  it('never mutates the source bytes', () => {
    const src = bytes('multi-page')
    const before = src.slice()
    replay(new Map([[SRC, src]]), doc([2, 1, 0]))
    expect(src).toEqual(before)
  })
})
