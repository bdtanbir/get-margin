import { describe, it, expect } from 'vitest'
import * as mupdf from 'mupdf'
import { PDFDocument } from 'pdf-lib'
import { replay } from '../../src/write/index.js'
import { PatchRefused } from '../../src/write/objects/patch.js'
import {
  emptyEditDocument, type EditDocument, type EditObject, type ImagePatchObject,
} from '../../src/write/types.js'
import { PdfDocument, renderPage } from '../../src/index.js'
import { pageImages } from '../../src/images/index.js'

/** A solid block of one colour, so "was it covered" has an unambiguous answer. */
function solid(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const px = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false)
  const buf = px.getPixels()
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]
  }
  const out = px.asJPEG(95)
  px.destroy()
  return out
}

/**
 * A page with two images: a RED block low on the page and a BLUE one high
 * up, plus a line of text that must survive whatever happens to them.
 */
async function twoImages(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const red = await doc.embedJpg(solid(80, 40, [220, 20, 20]))
  const blue = await doc.embedJpg(solid(80, 40, [20, 20, 220]))
  page.drawImage(red, { x: 50, y: 100, width: 200, height: 100 })
  page.drawImage(blue, { x: 50, y: 600, width: 200, height: 100 })
  page.drawText('keep me', { x: 400, y: 400, size: 24 })
  return doc.save()
}

const source = await twoImages()

/** The placements as the app would read them, to address a patch by. */
function placements(pdf: Uint8Array) {
  const d = PdfDocument.open(pdf)
  try {
    const p = d._raw().loadPage(0) as mupdf.PDFPage
    try { return pageImages(p) } finally { p.destroy() }
  } finally { d.close() }
}

function patch(over: Partial<ImagePatchObject> = {}): ImagePatchObject {
  const place = placements(source)[0]!
  return {
    id: 'ip1', pageId: 'p0', kind: 'imagePatch',
    imageIndex: 0,
    originalHash: place.hash,
    background: [1, 1, 1],
    backgroundConfidence: 1,
    rect: { x: place.bbox[0], y: place.bbox[1], w: place.bbox[2] - place.bbox[0], h: place.bbox[3] - place.bbox[1] },
    rotation: 0, z: 1, locked: false, opacity: 1,
    ...over,
  }
}

function docWith(objects: EditObject[]): EditDocument {
  return {
    ...emptyEditDocument(),
    sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: ['p0'],
    pages: { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
  }
}

const write = (objects: EditObject[]): Uint8Array =>
  replay(new Map([['src-0', source]]), docWith(objects))

/** One pixel of a rendered page, at scale 1 so a point is a pixel. */
function pixel(pdf: Uint8Array, x: number, y: number) {
  const d = PdfDocument.open(pdf)
  try {
    const { width, rgba } = renderPage(d, 0, 1)
    const i = (Math.round(y) * width + Math.round(x)) * 4
    return { r: rgba[i]!, g: rgba[i + 1]!, b: rgba[i + 2]! }
  } finally { d.close() }
}

const isRed = (p: { r: number; g: number; b: number }) => p.r > 150 && p.g < 100
const isWhite = (p: { r: number; g: number; b: number }) => p.r > 240 && p.g > 240 && p.b > 240

// The red image occupies x 50..250 and, top-down on a 792pt page, y 592..692.
const RED_CENTRE: [number, number] = [150, 642]
// The blue one is at y 92..192 top-down.
const BLUE_CENTRE: [number, number] = [150, 142]

describe('imagePatch writer', () => {
  it('the fixture really does draw the image it is about to cover', () => {
    expect(isRed(pixel(source, ...RED_CENTRE))).toBe(true)
  })

  it('covers the image it points at', () => {
    const out = write([patch()])
    expect(isWhite(pixel(out, ...RED_CENTRE))).toBe(true)
  })

  it('leaves the page\'s other image alone', () => {
    const out = write([patch()])
    const blue = pixel(out, ...BLUE_CENTRE)
    expect(blue.b).toBeGreaterThan(150)
    expect(blue.r).toBeLessThan(100)
  })

  it('covers in the sampled background colour, not always white', () => {
    const out = write([patch({ background: [0, 0.5, 0] })])
    const p = pixel(out, ...RED_CENTRE)
    expect(p.g).toBeGreaterThan(90)
    expect(p.r).toBeLessThan(90)
  })

  it('addresses the second image by its draw order', () => {
    const place = placements(source)[1]!
    const out = write([patch({ imageIndex: 1, originalHash: place.hash })])
    expect(isWhite(pixel(out, ...BLUE_CENTRE))).toBe(true)
    expect(isRed(pixel(out, ...RED_CENTRE))).toBe(true)
  })

  /**
   * The guard. Covering whatever happens to be at index 0 now is the worst
   * outcome available -- it damages a document while reporting success.
   */
  it('refuses when the image at that index is not the one that was edited', () => {
    // The refusal arrives as the `cause`: replay names the object and the
    // page, and asserting on the cause rather than on that wrapper keeps
    // this pinned to the guard rather than to the wording around it. Same
    // convention as patch.test.ts.
    let caught: unknown
    try { write([patch({ originalHash: 'deadbeef' })]) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).cause).toBeInstanceOf(PatchRefused)
  })

  it('refuses when the image is no longer on the page at all', () => {
    expect(() => write([patch({ imageIndex: 7 })])).toThrow(/no longer on the page/)
  })

  it('names the object and the page it refused', () => {
    expect(() => write([patch({ imageIndex: 7 })])).toThrow(/imagePatch on page 1/)
  })

  it('says which image it refused, and why', () => {
    expect(() => write([patch({ originalHash: 'deadbeef' })]))
      .toThrow(/image 1[\s\S]*changed/i)
  })

  /**
   * A SPECIFICATION, not an oversight -- the same one whiteout.test.ts
   * pins. This covers; it does not remove. Redaction is a different
   * primitive with a different guarantee, and a "delete" that quietly left
   * the bytes behind while implying otherwise is the wrong kind of quiet.
   */
  it('does NOT remove the image from the file — it only covers it', () => {
    const out = write([patch()])
    expect(placements(out)).toHaveLength(2)
  })

  it('keeps the rest of the page', () => {
    const out = write([patch()])
    const d = PdfDocument.open(out)
    try {
      const p = d._raw().loadPage(0)
      try { expect(p.toStructuredText('').asText()).toContain('keep me') } finally { p.destroy() }
    } finally { d.close() }
  })
})
