import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { replay } from '../../src/write/index.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument, type EditObject } from '../../src/write/types.js'
import { PdfDocument, renderPage } from '../../src/index.js'
import { pdfToView } from '@margin/transform'
import { generateFixtures, fixturePath } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: Parameters<typeof fixturePath>[0]): Uint8Array =>
  new Uint8Array(readFileSync(fixturePath(n)))

/** A solid-colour PNG, for the tests that sample a drawn pixel's colour. */
function solidPng(r: number, g: number, b: number, size = 200): Uint8Array {
  const png = new PNG({ width: size, height: size })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255
  }
  return new Uint8Array(PNG.sync.write(png, { deflateLevel: 0 }))
}

/** Deterministic PRNG, so a failure is reproducible rather than flaky. */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * An INCOMPRESSIBLE PNG. The size assertions below are about whether a
 * payload was embedded once or N times, and a solid-colour image collapses
 * to a few hundred bytes however it is stored -- which would make those
 * assertions pass for the wrong reason, or fail for no reason. Noise gives
 * the payload a floor MuPDF's re-encoding cannot compress away.
 */
function noisePng(seed: number, size = 160): Uint8Array {
  const rand = mulberry32(seed)
  const png = new PNG({ width: size, height: size })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = (rand() * 256) | 0
    png.data[i + 1] = (rand() * 256) | 0
    png.data[i + 2] = (rand() * 256) | 0
    png.data[i + 3] = 255
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

function imageObject(id: string, data: Uint8Array, rect = { x: 100, y: 300, w: 120, h: 120 }, pageId = 'p0'): EditObject {
  return {
    id, pageId, kind: 'image', data, mime: 'image/png',
    rect, rotation: 0, z: 1, locked: false, opacity: 1,
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

describe('image writer', () => {
  const geom = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }

  it('draws the image at the stored PDF coordinates', () => {
    const out = replay(new Map([['src-0', bytes('multi-page')]]), docWith([imageObject('i1', solidPng(255, 0, 0))]))
    const c = pdfToView({ x: 160, y: 360 }, geom, 1)
    const px = sample(out, c.x, c.y)
    expect(px.r).toBeGreaterThan(200)
    expect(px.g).toBeLessThan(60)
    expect(px.b).toBeLessThan(60)
  })

  it('draws right way up, not vertically mirrored', () => {
    // Top half red, bottom half blue -- a flipped CTM would swap them.
    const png = new PNG({ width: 100, height: 100 })
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        const i = (y * 100 + x) * 4
        const top = y < 50
        png.data[i] = top ? 255 : 0
        png.data[i + 1] = 0
        png.data[i + 2] = top ? 0 : 255
        png.data[i + 3] = 255
      }
    }
    const data = new Uint8Array(PNG.sync.write(png, { deflateLevel: 0 }))
    const rect = { x: 100, y: 300, w: 100, h: 100 }
    const out = replay(new Map([['src-0', bytes('multi-page')]]), docWith([imageObject('i1', data, rect)]))
    // PDF y=380 is near the TOP of the box, which is the image's top half.
    const top = pdfToView({ x: 150, y: 380 }, geom, 1)
    const bottom = pdfToView({ x: 150, y: 320 }, geom, 1)
    expect(sample(out, top.x, top.y).r).toBeGreaterThan(200)
    expect(sample(out, bottom.x, bottom.y).b).toBeGreaterThan(200)
  })

  it('grows the exported file by roughly the image payload', () => {
    const data = noisePng(1)
    const bare = replay(new Map([['src-0', bytes('multi-page')]]), docWith([]))
    const out = replay(new Map([['src-0', bytes('multi-page')]]), docWith([imageObject('i1', data)]))
    // 160x160 of RGB noise cannot compress below ~50KB.
    expect(out.byteLength).toBeGreaterThan(bare.byteLength + 50_000)
  })

  // The XObject is keyed by payload, so N placements of one image are one
  // embedded stream -- a signature stamped on every page must not carry a
  // full copy per page.
  // The XObject is keyed by payload, so N placements of one image are one
  // embedded stream -- a signature stamped on every page must not carry a
  // full copy per page. Asserted as a comparison between the duplicate and
  // distinct cases, which is the actual property and does not depend on how
  // well any one payload happens to compress.
  it('embeds one shared XObject for repeated placements of the same bytes', () => {
    const data = noisePng(2)
    const place = (id: string, x: number) => imageObject(id, data, { x, y: 300, w: 60, h: 60 })
    const one = replay(new Map([['src-0', bytes('multi-page')]]), docWith([place('i1', 100)]))
    const four = replay(new Map([['src-0', bytes('multi-page')]]), docWith(
      [place('i1', 100), place('i2', 200), place('i3', 300), place('i4', 400)],
    ))
    // Three extra placements add three short content fragments (well under
    // 1KB), not three more copies of a ~50KB payload.
    expect(four.byteLength - one.byteLength).toBeLessThan(1_000)
  })

  it('shares the XObject across pages, not just within one', () => {
    const data = noisePng(3)
    const rect = { x: 100, y: 300, w: 60, h: 60 }
    const onePage = replay(new Map([['src-0', bytes('multi-page')]]), docWith([imageObject('i1', data, rect, 'p0')]))
    const twoPages = replay(new Map([['src-0', bytes('multi-page')]]), docWith([
      imageObject('i1', data, rect, 'p0'),
      imageObject('i2', data, rect, 'p1'),
    ]))
    expect(twoPages.byteLength - onePage.byteLength).toBeLessThan(1_000)
    // ...and it actually drew on the second page too.
    const c = pdfToView({ x: 130, y: 330 }, geom, 1)
    const px = sample(twoPages, c.x, c.y, 1)
    expect(px.r + px.g + px.b).toBeLessThan(720)
  })

  it('embeds two DIFFERENT images separately', () => {
    const rect = (x: number) => ({ x, y: 300, w: 60, h: 60 })
    const one = replay(new Map([['src-0', bytes('multi-page')]]), docWith([imageObject('i1', noisePng(4), rect(100))]))
    const two = replay(new Map([['src-0', bytes('multi-page')]]), docWith([
      imageObject('i1', noisePng(4), rect(100)),
      imageObject('i2', noisePng(5), rect(200)),
    ]))
    // A distinct payload costs a full second embed, unlike the duplicate above.
    expect(two.byteLength - one.byteLength).toBeGreaterThan(50_000)
  })

  it('honours opacity', () => {
    const out = replay(new Map([['src-0', bytes('multi-page')]]), docWith([{
      ...imageObject('i1', solidPng(255, 0, 0)), opacity: 0.5,
    } as EditObject]))
    const c = pdfToView({ x: 160, y: 360 }, geom, 1)
    const px = sample(out, c.x, c.y)
    expect(px.g).toBeGreaterThan(90)
    expect(px.g).toBeLessThan(200)
  })
})
