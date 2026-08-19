import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { replay, WRITERS } from '../../src/write/index.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument, type EditObject } from '../../src/write/types.js'
import { PdfDocument, renderPage } from '../../src/index.js'
import { pdfToView } from '@margin/transform'
import { generateFixtures, fixturePath } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: Parameters<typeof fixturePath>[0]): Uint8Array =>
  new Uint8Array(readFileSync(fixturePath(n)))

/** A PNG with a transparent background and one opaque black band. */
function signaturePng(size = 120): Uint8Array {
  const png = new PNG({ width: size, height: size })
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const ink = y > size * 0.4 && y < size * 0.6
      png.data[i] = 0; png.data[i + 1] = 0; png.data[i + 2] = 0
      png.data[i + 3] = ink ? 255 : 0
    }
  }
  return new Uint8Array(PNG.sync.write(png))
}

function docWith(objects: EditObject[]): EditDocument {
  return {
    version: EDIT_DOCUMENT_VERSION, sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: ['p0', 'p1'], pages: { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null }, p1: { sourceIndex: 1, sourceId: 'src-0', rotation: 0, cropBox: null } },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])), nextZ: 99,
  }
}

function signature(id: string, data: Uint8Array, pageId = 'p0'): EditObject {
  return {
    id, pageId, kind: 'signature', data, mime: 'image/png',
    rect: { x: 100, y: 300, w: 200, h: 200 },
    rotation: 0, z: 1, locked: false, opacity: 1,
  } as EditObject
}

function sample(pdf: Uint8Array, x: number, y: number, page = 0) {
  const doc = PdfDocument.open(pdf)
  try {
    const { width, rgba } = renderPage(doc, page, 1)
    const i = (Math.round(y) * width + Math.round(x)) * 4
    return { r: rgba[i]!, g: rgba[i + 1]!, b: rgba[i + 2]! }
  } finally { doc.close() }
}

describe('signature writer', () => {
  const geom = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }

  // Shared, not copied: the two differ only in provenance and inspector
  // fields, and a near-copy would drift.
  it('reuses the image writer rather than duplicating it', () => {
    expect(WRITERS.signature).toBe(WRITERS.image)
  })

  it('draws the ink band on the page', () => {
    const out = replay(bytes('multi-page'), docWith([signature('s1', signaturePng())]))
    // The band sits across the middle of the 200pt-tall box (y 300..500).
    const c = pdfToView({ x: 200, y: 400 }, geom, 1)
    const px = sample(out, c.x, c.y)
    expect(px.r).toBeLessThan(80)
  })

  // The whole point of removeBackground: the surrounding area must stay
  // transparent so the page shows through, not be covered by a white block.
  it('leaves the transparent surround showing the page through', () => {
    const out = replay(bytes('multi-page'), docWith([signature('s1', signaturePng())]))
    const c = pdfToView({ x: 200, y: 480 }, geom, 1)
    const px = sample(out, c.x, c.y)
    expect(px.r).toBeGreaterThan(200)
    expect(px.g).toBeGreaterThan(200)
    expect(px.b).toBeGreaterThan(200)
  })

  // One signature applied to every page of a contract must embed once.
  it('embeds once when applied to several pages', () => {
    const data = signaturePng()
    const one = replay(bytes('multi-page'), docWith([signature('s1', data, 'p0')]))
    const two = replay(bytes('multi-page'), docWith([
      signature('s1', data, 'p0'),
      signature('s2', data, 'p1'),
    ]))
    expect(two.byteLength - one.byteLength).toBeLessThan(1_000)
  })
})
