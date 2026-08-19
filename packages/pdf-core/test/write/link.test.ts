import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { replay } from '../../src/write/index.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument, type EditObject } from '../../src/write/types.js'
import { PdfDocument } from '../../src/index.js'
import { pdfRectToView } from '@margin/transform'
import { generateFixtures, fixturePath } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: Parameters<typeof fixturePath>[0]): Uint8Array =>
  new Uint8Array(readFileSync(fixturePath(n)))

function docWith(objects: EditObject[]): EditDocument {
  return {
    version: EDIT_DOCUMENT_VERSION, sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: ['p0'], pages: { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])), nextZ: 99,
  }
}

function linkObject(uri: string, rect = { x: 100, y: 400, w: 200, h: 30 }): EditObject {
  return {
    id: 'l1', pageId: 'p0', kind: 'link', uri,
    rect, rotation: 0, z: 1, locked: false, opacity: 1,
  } as EditObject
}

function linksOf(pdf: Uint8Array, page = 0): Array<{ uri: string; bounds: number[] }> {
  const doc = PdfDocument.open(pdf)
  try {
    const p = doc._raw().loadPage(page)
    try {
      return p.getLinks().map((l) => ({ uri: l.getURI(), bounds: [...l.getBounds()] }))
    } finally { p.destroy() }
  } finally { doc.close() }
}

describe('link writer', () => {
  it('writes a link hotspot carrying the URI', () => {
    const out = replay(bytes('simple-text'), docWith([linkObject('https://example.com/')]))
    const links = linksOf(out)
    expect(links).toHaveLength(1)
    expect(links[0]!.uri).toBe('https://example.com/')
  })

  // Convention A: createLink's bbox is TOP-DOWN page space at scale 1. Phase 0
  // round-tripped getURI() but never checked where the hotspot landed, so this
  // is the assertion that pins it -- an unflipped rect would put the clickable
  // area on the mirror image of the visible affordance.
  it('places the hotspot where the overlay drew it', () => {
    const rect = { x: 100, y: 400, w: 200, h: 30 }
    const out = replay(bytes('simple-text'), docWith([linkObject('https://example.com/', rect)]))
    const geom = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }
    const expected = pdfRectToView(rect, geom, 1)
    const [x0, y0, x1, y1] = linksOf(out)[0]!.bounds as [number, number, number, number]
    expect(Math.abs(x0 - expected.x)).toBeLessThan(1)
    expect(Math.abs(y0 - expected.y)).toBeLessThan(1)
    expect(Math.abs(x1 - x0 - expected.w)).toBeLessThan(1)
    expect(Math.abs(y1 - y0 - expected.h)).toBeLessThan(1)
  })

  it('places the hotspot correctly on a non-zero-CropBox page', () => {
    const doc = PdfDocument.open(bytes('offset-cropbox'))
    let g
    try { g = doc.pageGeometry(0) } finally { doc.close() }
    const [x0, y0] = g.cropBox
    const rect = { x: x0 + 50, y: y0 + 100, w: 120, h: 24 }
    const out = replay(bytes('offset-cropbox'), docWith([linkObject('https://example.com/', rect)]))
    const expected = pdfRectToView(rect, g, 1)
    const bounds = linksOf(out)[0]!.bounds as [number, number, number, number]
    expect(Math.abs(bounds[0] - expected.x)).toBeLessThan(1)
    expect(Math.abs(bounds[1] - expected.y)).toBeLessThan(1)
  })

  it('writes several links on one page', () => {
    const out = replay(bytes('simple-text'), docWith([
      { ...linkObject('https://a.example/'), id: 'l1' } as EditObject,
      { ...linkObject('https://b.example/', { x: 100, y: 300, w: 200, h: 30 }), id: 'l2' } as EditObject,
    ]))
    expect(linksOf(out).map((l) => l.uri).sort()).toEqual(['https://a.example/', 'https://b.example/'])
  })

  it('preserves a mailto: link verbatim', () => {
    const out = replay(bytes('simple-text'), docWith([linkObject('mailto:someone@example.com')]))
    expect(linksOf(out)[0]!.uri).toBe('mailto:someone@example.com')
  })

  // fz_link has no /AP. Nothing is drawn into the content stream, so the
  // exported page must look exactly as it did before the link was added --
  // the dashed affordance is editor-only.
  it('draws nothing visible into the page', async () => {
    const { renderPage } = await import('../../src/index.js')
    const pixels = (pdf: Uint8Array) => {
      const doc = PdfDocument.open(pdf)
      try { return [...renderPage(doc, 0, 1).rgba] } finally { doc.close() }
    }
    const bare = replay(bytes('simple-text'), docWith([]))
    const linked = replay(bytes('simple-text'), docWith([linkObject('https://example.com/')]))
    expect(pixels(linked)).toEqual(pixels(bare))
  })
})
