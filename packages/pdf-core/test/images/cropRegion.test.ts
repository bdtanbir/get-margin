import { describe, it, expect } from 'vitest'
import * as mupdf from 'mupdf'
import { PDFDocument, rgb } from 'pdf-lib'
import { PdfDocument } from '../../src/index.js'
import { cropRegion } from '../../src/images/index.js'

/**
 * A page of VECTOR art, which is the whole reason this exists: page 2 of a
 * real US-Bangla e-ticket draws its logo as 21 paths rather than as an
 * image, so nothing in the image index can reach it.
 *
 * A red square at 50,600..150,700 in PDF space, which is 50,92..150,192
 * top-down on a 792pt page.
 */
async function vectorArt(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  page.drawRectangle({ x: 50, y: 600, width: 100, height: 100, color: rgb(0.9, 0.1, 0.1) })
  page.drawRectangle({ x: 300, y: 300, width: 60, height: 60, color: rgb(0.1, 0.1, 0.9) })
  return doc.save()
}

const src = await vectorArt()

function decode(png: Uint8Array) {
  const image = new mupdf.Image(png)
  const px = image.toPixmap()
  try {
    return {
      width: px.getWidth(),
      height: px.getHeight(),
      pixels: new Uint8Array(px.getPixels()),
      components: px.getNumberOfComponents(),
    }
  } finally { px.destroy(); image.destroy() }
}

const withDoc = <T>(fn: (d: PdfDocument) => T): T => {
  const d = PdfDocument.open(src)
  try { return fn(d) } finally { d.close() }
}

/** The region covering the red square, in MuPDF page space (top-down). */
const RED = { x: 50, y: 92, w: 100, h: 100 }

const middle = (png: Uint8Array) => {
  const { pixels, components } = decode(png)
  const at = Math.floor(pixels.length / components / 2) * components
  return { r: pixels[at]!, g: pixels[at + 1]!, b: pixels[at + 2]! }
}

describe('cropRegion', () => {
  it('returns the region as PNG', () => {
    const out = withDoc((d) => cropRegion(d, 0, RED, 1))
    expect(Array.from(out!.data.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('captures vector art, which no image walk can see', () => {
    const p = middle(withDoc((d) => cropRegion(d, 0, RED, 1))!.data)
    expect(p.r).toBeGreaterThan(150)
    expect(p.g).toBeLessThan(100)
  })

  it('crops to the region asked for, not the whole page', () => {
    const { width, height } = decode(withDoc((d) => cropRegion(d, 0, RED, 1))!.data)
    expect(width).toBeCloseTo(100, -1)
    expect(height).toBeCloseTo(100, -1)
  })

  it('renders at the scale it is asked for', () => {
    const { width } = decode(withDoc((d) => cropRegion(d, 0, RED, 4))!.data)
    expect(width).toBeCloseTo(400, -1)
  })

  it('takes the region it was pointed at, not another one', () => {
    // The blue square: 300,300..360,360 bottom-up is 300,432..360,492 above.
    const p = middle(withDoc((d) => cropRegion(d, 0, { x: 300, y: 432, w: 60, h: 60 }, 1))!.data)
    expect(p.b).toBeGreaterThan(150)
    expect(p.r).toBeLessThan(100)
  })

  it('gives back paper where the page draws nothing', () => {
    const p = middle(withDoc((d) => cropRegion(d, 0, { x: 400, y: 600, w: 50, h: 50 }, 1))!.data)
    expect(p.r).toBeGreaterThan(240)
    expect(p.g).toBeGreaterThan(240)
    expect(p.b).toBeGreaterThan(240)
  })

  /**
   * A region big enough to blow the pixel budget is rendered COARSER
   * rather than refused: a lift of half a page is a reasonable thing to
   * ask for, and a 200MB raster is not a reasonable way to answer it.
   */
  it('drops the scale rather than producing an enormous raster', () => {
    const huge = withDoc((d) => cropRegion(d, 0, { x: 0, y: 0, w: 612, h: 792 }, 8))!
    const { width, height } = decode(huge.data)
    expect(width * height).toBeLessThanOrEqual(4_000_000)
    // Still a usable raster, not a thumbnail.
    expect(width).toBeGreaterThan(612)
  })

  it('refuses a region with no area', () => {
    expect(withDoc((d) => cropRegion(d, 0, { x: 10, y: 10, w: 0, h: 50 }, 1))).toBeUndefined()
  })

  it('clamps a region that runs off the page', () => {
    const out = withDoc((d) => cropRegion(d, 0, { x: 580, y: 100, w: 200, h: 50 }, 1))
    expect(out).toBeDefined()
    const { width } = decode(out!.data)
    // 612 - 580 = 32pt of actual page.
    expect(width).toBeCloseTo(32, -1)
  })
})
