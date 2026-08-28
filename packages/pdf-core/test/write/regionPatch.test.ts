import { describe, it, expect } from 'vitest'
import * as mupdf from 'mupdf'
import { PDFDocument, rgb } from 'pdf-lib'
import { replay } from '../../src/write/index.js'
import {
  emptyEditDocument, type EditDocument, type EditObject, type RegionPatchObject,
} from '../../src/write/types.js'
import { PdfDocument, renderPage } from '../../src/index.js'
import { pageImages } from '../../src/images/index.js'

/**
 * A page of VECTOR art and text -- deliberately NOTHING an image walk can
 * see, because that is the case this kind exists for. Page 2 of a real
 * US-Bangla e-ticket draws its logo as 21 paths, and no amount of image
 * indexing will ever reach it.
 *
 * A red square at 50,600..150,700 in PDF space: 50,92..150,192 top-down.
 */
async function vectorArt(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  page.drawRectangle({ x: 50, y: 600, width: 100, height: 100, color: rgb(0.9, 0.1, 0.1) })
  page.drawText('keep me', { x: 400, y: 400, size: 24 })
  return doc.save()
}

const source = await vectorArt()

/** The red square, in MuPDF page space (top-down). */
const RED = { x: 50, y: 92, w: 100, h: 100 }
const RED_CENTRE: [number, number] = [100, 142]

function patch(over: Partial<RegionPatchObject> = {}): RegionPatchObject {
  return {
    id: 'rp1', pageId: 'p0', kind: 'regionPatch',
    background: [1, 1, 1], backgroundConfidence: 1,
    rect: { ...RED },
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
const isGreen = (p: { r: number; g: number; b: number }) => p.g > 150 && p.r < 120

const green = (): Uint8Array => {
  const px = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 40], false)
  const buf = px.getPixels()
  for (let i = 0; i < buf.length; i += 3) { buf[i] = 20; buf[i + 1] = 200; buf[i + 2] = 20 }
  const out = px.asPNG()
  px.destroy()
  return out
}

describe('regionPatch writer', () => {
  it('the fixture draws vector art that no image walk can see', () => {
    expect(isRed(pixel(source, ...RED_CENTRE))).toBe(true)
    const d = PdfDocument.open(source)
    try {
      const p = d._raw().loadPage(0) as mupdf.PDFPage
      try { expect(pageImages(p)).toEqual([]) } finally { p.destroy() }
    } finally { d.close() }
  })

  it('covers the region it describes', () => {
    expect(isWhite(pixel(write([patch()]), ...RED_CENTRE))).toBe(true)
  })

  it('covers in the sampled colour, not always white', () => {
    const p = pixel(write([patch({ background: [0, 0.5, 0] })]), ...RED_CENTRE)
    expect(p.g).toBeGreaterThan(90)
    expect(p.r).toBeLessThan(90)
  })

  it('leaves the rest of the page alone', () => {
    const out = write([patch()])
    const d = PdfDocument.open(out)
    try {
      const p = d._raw().loadPage(0)
      try { expect(p.toStructuredText('').asText()).toContain('keep me') } finally { p.destroy() }
    } finally { d.close() }
  })

  it('covers only what it was given', () => {
    const out = write([patch({ rect: { x: 50, y: 92, w: 50, h: 100 } })])
    // The left half goes, the right half stays.
    expect(isWhite(pixel(out, 75, 142))).toBe(true)
    expect(isRed(pixel(out, 130, 142))).toBe(true)
  })

  describe('moving', () => {
    it('leaves the original position covered', () => {
      const out = write([patch({ data: green(), mime: 'image/png', offset: { dx: 0, dy: 200 } })])
      expect(isWhite(pixel(out, ...RED_CENTRE))).toBe(true)
    })

    /**
     * THE SIGN. Page space is top-down and a content stream is bottom-up,
     * so the writer subtracts what the overlay adds -- the same pairing
     * the two patch kinds before this one already carry.
     */
    it('a positive dy moves the copy DOWN the page', () => {
      const out = write([patch({ data: green(), mime: 'image/png', offset: { dx: 0, dy: 200 } })])
      expect(isGreen(pixel(out, 100, 342))).toBe(true)
      expect(isGreen(pixel(out, 100, 142))).toBe(false)
    })

    it('a positive dx moves the copy RIGHT', () => {
      const out = write([patch({ data: green(), mime: 'image/png', offset: { dx: 200, dy: 0 } })])
      expect(isGreen(pixel(out, 300, 142))).toBe(true)
      expect(isGreen(pixel(out, 20, 142))).toBe(false)
    })

    it('draws the copy at the size of the region', () => {
      const out = write([patch({ data: green(), mime: 'image/png', offset: { dx: 0, dy: 200 } })])
      expect(isGreen(pixel(out, 55, 297))).toBe(true)
      expect(isGreen(pixel(out, 145, 387))).toBe(true)
      expect(isGreen(pixel(out, 160, 342))).toBe(false)
    })
  })

  /**
   * NO HASH GUARD, and that is a real difference from `imagePatch` rather
   * than an omission. An image patch is addressed by POSITION IN A WALK,
   * which means nothing without a check that the thing at that position is
   * still the thing that was edited. A region is addressed by its own
   * geometry: it describes the rectangle it covers, and that rectangle
   * means the same thing whatever else has changed.
   */
  it('does not refuse on a page whose content has changed', () => {
    expect(() => write([patch({ rect: { x: 0, y: 0, w: 10, h: 10 } })])).not.toThrow()
  })

  /**
   * A SPECIFICATION, not an oversight -- the same one whiteout.test.ts and
   * imagePatch.test.ts both pin. This covers; it does not remove.
   */
  it('does NOT remove what it covers — the text is still extractable', () => {
    const out = write([patch({ rect: { x: 380, y: 370, w: 150, h: 40 } })])
    const d = PdfDocument.open(out)
    try {
      const p = d._raw().loadPage(0)
      try { expect(p.toStructuredText('').asText()).toContain('keep me') } finally { p.destroy() }
    } finally { d.close() }
  })
})
