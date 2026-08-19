import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { replay } from '../../src/write/index.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument, type EditObject } from '../../src/write/types.js'
import { PdfDocument, renderPage } from '../../src/index.js'
import { pdfToView } from '@margin/transform'
import { assertGolden } from '../golden.js'

import { generateFixtures, fixturePath } from '../fixtures/index.js'

// Every pdf-core test bootstraps fixtures this way -- they are generated,
// not committed, so reading the path directly without this fails on a clean
// checkout. Matches test/golden.test.ts and test/render.test.ts.
beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: Parameters<typeof fixturePath>[0]): Uint8Array =>
  new Uint8Array(readFileSync(fixturePath(n)))

function docWith(objects: EditObject[]): EditDocument {
  return {
    version: EDIT_DOCUMENT_VERSION, sourceHash: '',
    pageOrder: ['p0'], pages: { p0: { sourceIndex: 0 } },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])), nextZ: 99,
  }
}

const base = {
  pageId: 'p0', rotation: 0, z: 1, locked: false, opacity: 1,
  stroke: [0, 0, 1] as [number, number, number], strokeWidth: 2, fill: null,
}

function sample(pdf: Uint8Array, x: number, y: number) {
  const doc = PdfDocument.open(pdf)
  try {
    const { width, rgba } = renderPage(doc, 0, 1)
    const i = (Math.round(y) * width + Math.round(x)) * 4
    return { r: rgba[i]!, g: rgba[i + 1]!, b: rgba[i + 2]! }
  } finally { doc.close() }
}

describe('shape writer', () => {
  const geom = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }

  it('fills a rect at the stored PDF coordinates', () => {
    const out = replay(bytes('simple-text'), docWith([{
      ...base, id: 'r1', kind: 'rect',
      rect: { x: 100, y: 300, w: 120, h: 80 },
      fill: [1, 0, 0], stroke: null,
    } as EditObject]))
    const c = pdfToView({ x: 160, y: 340 }, geom, 1)
    const px = sample(out, c.x, c.y)
    expect(px.r).toBeGreaterThan(200)
    expect(px.g).toBeLessThan(60)
  })

  it('leaves the interior of an unfilled rect untouched', () => {
    const out = replay(bytes('simple-text'), docWith([{
      ...base, id: 'r1', kind: 'rect',
      rect: { x: 100, y: 300, w: 120, h: 80 }, fill: null,
    } as EditObject]))
    const c = pdfToView({ x: 160, y: 340 }, geom, 1)
    const px = sample(out, c.x, c.y)
    expect(px.r).toBeGreaterThan(200)
    expect(px.g).toBeGreaterThan(200)
    expect(px.b).toBeGreaterThan(200)
  })

  it('honours opacity via an ExtGState', () => {
    const out = replay(bytes('simple-text'), docWith([{
      ...base, id: 'r1', kind: 'rect', opacity: 0.5,
      rect: { x: 100, y: 300, w: 120, h: 80 }, fill: [1, 0, 0], stroke: null,
    } as EditObject]))
    const c = pdfToView({ x: 160, y: 340 }, geom, 1)
    const px = sample(out, c.x, c.y)
    // Half-opacity red over white: red stays high, green/blue land mid-range
    // rather than near zero.
    expect(px.g).toBeGreaterThan(90)
    expect(px.g).toBeLessThan(200)
  })

  it('draws all four kinds without throwing', () => {
    const kinds = ['rect', 'ellipse', 'line', 'arrow'] as const
    const out = replay(bytes('simple-text'), docWith(kinds.map((kind, i) => ({
      ...base, id: `s${i}`, kind,
      rect: { x: 60 + i * 60, y: 500, w: 50, h: 40 },
    } as EditObject))))
    expect(out.byteLength).toBeGreaterThan(0)
  })

  // A shape with neither fill nor stroke must not fall back to painting
  // something the user did not ask for -- `n` ends the path with no marks.
  it('draws nothing for a shape with neither fill nor stroke', () => {
    const out = replay(bytes('simple-text'), docWith([{
      ...base, id: 'r1', kind: 'rect',
      rect: { x: 100, y: 300, w: 120, h: 80 }, fill: null, stroke: null,
    } as EditObject]))
    for (const p of [{ x: 160, y: 340 }, { x: 100, y: 300 }, { x: 220, y: 380 }]) {
      const c = pdfToView(p, geom, 1)
      const px = sample(out, c.x, c.y)
      expect(px.r).toBeGreaterThan(200)
      expect(px.g).toBeGreaterThan(200)
      expect(px.b).toBeGreaterThan(200)
    }
  })

  // The write path opens a SECOND document from the pristine bytes, so the
  // caller's array must come back untouched however many times it is used.
  it('does not mutate the source bytes', () => {
    const src = bytes('simple-text')
    const before = src.slice()
    replay(src, docWith([{
      ...base, id: 'r1', kind: 'rect', rect: { x: 10, y: 10, w: 20, h: 20 }, fill: [1, 0, 0],
    } as EditObject]))
    expect(src).toEqual(before)
  })

  // Convention B has to hold on a page whose CropBox origin is not (0,0):
  // content-stream coordinates are RAW user space, so the origin is NOT
  // subtracted. Sampling has to go through pdfToView, which does subtract it.
  it('places a rect correctly on a non-zero-CropBox page', () => {
    const doc = PdfDocument.open(bytes('offset-cropbox'))
    let g
    try { g = doc.pageGeometry(0) } finally { doc.close() }
    const [x0, y0] = g.cropBox
    const rect = { x: x0 + 40, y: y0 + 40, w: 80, h: 60 }
    const out = replay(bytes('offset-cropbox'), docWith([{
      ...base, id: 'r1', kind: 'rect', rect, fill: [1, 0, 0], stroke: null,
    } as EditObject]))
    const c = pdfToView({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, g, 1)
    const px = sample(out, c.x, c.y)
    expect(px.r).toBeGreaterThan(200)
    expect(px.g).toBeLessThan(60)
  })

  it('matches the reviewed golden', async () => {
    const out = replay(bytes('simple-text'), docWith([
      { ...base, id: 'a', kind: 'rect', rect: { x: 60, y: 600, w: 120, h: 60 }, fill: [1, 0.9, 0.2] } as EditObject,
      { ...base, id: 'b', kind: 'ellipse', rect: { x: 220, y: 600, w: 120, h: 60 } } as EditObject,
      { ...base, id: 'c', kind: 'line', rect: { x: 60, y: 540, w: 280, h: 0 } } as EditObject,
      { ...base, id: 'd', kind: 'arrow', rect: { x: 60, y: 480, w: 280, h: 0 } } as EditObject,
    ]))
    await assertGolden('export-shapes', out)
  })
})
