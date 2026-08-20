import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { pageViewSize } from '@margin/transform'
import { PDFDocument } from 'pdf-lib'
import { PdfDocument, rasterisePage, rasterSize, rasterPixels, DPI_PRESETS } from '../src/index.js'
import { generateFixtures, fixturePath } from './fixtures/index.js'

beforeAll(async () => {
  await generateFixtures()
}, 60_000)

const bytes = (n: Parameters<typeof fixturePath>[0]) => new Uint8Array(readFileSync(fixturePath(n)))

/**
 * JPEG's own header, read rather than trusted.
 *
 * SOI, then the SOF marker that carries the real dimensions. Asserting the
 * decoder's view of the file is what makes "it produced a JPEG" mean
 * something -- a function returning any bytes at all would satisfy a
 * length check.
 */
function readJpeg(data: Uint8Array): { width: number; height: number } {
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error('not a JPEG: no SOI marker')
  let i = 2
  while (i < data.length) {
    if (data[i] !== 0xff) throw new Error(`expected a marker at byte ${i}`)
    const marker = data[i + 1]!
    // SOF0..SOF3 and SOF5..SOF15 carry the frame header; the excluded ones
    // are restart and standalone markers with no length field.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (data[i + 5]! << 8) | data[i + 6]!, width: (data[i + 7]! << 8) | data[i + 8]! }
    }
    i += 2 + ((data[i + 2]! << 8) | data[i + 3]!)
  }
  throw new Error('no frame header found')
}

describe('rasterisePage', () => {
  it('produces a JPEG a decoder agrees is a JPEG', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    const page = rasterisePage(doc, 0, 72, 'jpeg')
    expect(page.format).toBe('jpeg')
    // The bytes, decoded -- not a magic-number check and not a length check.
    expect(readJpeg(page.bytes)).toEqual({ width: 612, height: 792 })
    expect(readJpeg(page.bytes)).toEqual({ width: page.width, height: page.height })
    doc.close()
  })

  it('produces a PNG a decoder agrees is a PNG', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    const page = rasterisePage(doc, 0, 72, 'png')
    const decoded = PNG.sync.read(Buffer.from(page.bytes))
    expect({ width: decoded.width, height: decoded.height }).toEqual({ width: 612, height: 792 })
    doc.close()
  })

  /**
   * DPI is the only control the dialog offers, so it has to do the obvious
   * thing: 72 is one pixel per point, and 300 is a bit over four.
   */
  it('changes the pixel dimensions with the DPI', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    const at72 = readJpeg(rasterisePage(doc, 0, 72).bytes)
    const at150 = readJpeg(rasterisePage(doc, 0, 150).bytes)
    const at300 = readJpeg(rasterisePage(doc, 0, 300).bytes)

    expect(at72).toEqual({ width: 612, height: 792 })
    expect(at150).toEqual({ width: 1275, height: 1650 })
    expect(at300).toEqual({ width: 2550, height: 3300 })
    doc.close()
  })

  it('offers every preset DPI as something that actually renders', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    for (const preset of DPI_PRESETS) {
      const page = rasterisePage(doc, 0, preset.dpi)
      expect(readJpeg(page.bytes).width).toBeGreaterThan(0)
    }
    doc.close()
  })

  /** Lower quality has to mean fewer bytes, or the control is decorative. */
  it('makes a smaller file at a lower JPEG quality', () => {
    const doc = PdfDocument.open(bytes('mixed-fonts'))
    const high = rasterisePage(doc, 0, 150, 'jpeg', { quality: 95 })
    const low = rasterisePage(doc, 0, 150, 'jpeg', { quality: 30 })
    expect(low.bytes.length).toBeLessThan(high.bytes.length)
    // Same picture, fewer bytes -- not a smaller picture.
    expect(readJpeg(low.bytes)).toEqual(readJpeg(high.bytes))
    doc.close()
  })

  it('clamps a nonsensical quality rather than passing it through', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    for (const quality of [0, -20, 1000, Number.NaN]) {
      expect(() => rasterisePage(doc, 0, 72, 'jpeg', { quality })).not.toThrow()
    }
    doc.close()
  })

  /**
   * The same fact `render.ts` depends on: MuPDF bakes /Rotate into the
   * pixmap, so a quarter-turned page comes out with its dimensions swapped.
   * Getting this wrong exports a sideways page, which no test of page 0
   * would ever catch.
   */
  it('exports a rotated page the way the reader sees it', () => {
    const doc = PdfDocument.open(bytes('rotated'))
    for (let i = 0; i < 4; i++) {
      const expected = pageViewSize(doc.pageGeometry(i), 1)
      const actual = readJpeg(rasterisePage(doc, i, 72).bytes)
      expect(actual, `page ${i} rotate ${doc.pageGeometry(i).rotate}`).toEqual({
        width: Math.round(expected.width),
        height: Math.round(expected.height),
      })
    }
    doc.close()
  })

  it('rasterises each page of a multi-page document separately', () => {
    const doc = PdfDocument.open(bytes('multi-page'))
    const first = rasterisePage(doc, 0, 72)
    const second = rasterisePage(doc, 1, 72)
    // Different pages, different pixels. Identical bytes would mean the
    // index was ignored and every page exported as page one.
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(false)
    doc.close()
  })

  it('refuses a page that is not there, and a DPI that is not a number', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    expect(() => rasterisePage(doc, 99, 72)).toThrow()
    expect(() => rasterisePage(doc, 0, 0)).toThrow(RangeError)
    expect(() => rasterisePage(doc, 0, -150)).toThrow(RangeError)
    expect(() => rasterisePage(doc, 0, Number.NaN)).toThrow(RangeError)
    doc.close()
  })

  /** A page with a non-zero origin must not export shifted or cropped. */
  it('handles an offset CropBox', () => {
    const doc = PdfDocument.open(bytes('offset-cropbox'))
    const expected = pageViewSize(doc.pageGeometry(0), 1)
    expect(readJpeg(rasterisePage(doc, 0, 72).bytes)).toEqual({
      width: Math.round(expected.width),
      height: Math.round(expected.height),
    })
    doc.close()
  })
})

describe('rasterSize', () => {
  /**
   * The dialog says "2550 x 3300" before the user commits to an export
   * that might be a hundred megabytes. Rendering to find out would defeat
   * the point, so this has to agree with the renderer without calling it.
   */
  it('predicts what rasterisePage will produce, without rendering', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    for (const dpi of [72, 150, 300]) {
      expect(rasterSize(doc, 0, dpi)).toEqual(readJpeg(rasterisePage(doc, 0, dpi).bytes))
    }
    doc.close()
  })

  it('predicts a rotated page correctly too', () => {
    const doc = PdfDocument.open(bytes('rotated'))
    for (let i = 0; i < 4; i++) {
      expect(rasterSize(doc, i, 150), `page ${i}`).toEqual(
        readJpeg(rasterisePage(doc, i, 150).bytes),
      )
    }
    doc.close()
  })
})

/**
 * The case the fixtures could not reach.
 *
 * Every fixture in this repo is US Letter -- 612 x 792, both integers --
 * so `rasterSize` agreed with the renderer for the wrong reason: at these
 * DPIs the arithmetic lands on whole numbers and any rounding rule works.
 * Real documents are mostly A4, which is 595.276 x 841.89.
 *
 * MuPDF's `fz_round_rect` uses `ceil(edge - 0.001)`. Plain rounding
 * disagreed with it on half of the 48 combinations measured while writing
 * this. That is an engine fact rather than a spec one, so this matrix is
 * what notices if a future MuPDF changes it -- the same role the
 * "agrees with pageViewSize for every rotation" test plays for
 * MUPDF_APPLIES_ROTATION.
 */
describe('rasterSize agrees with the engine on pages that are not whole points', () => {
  /** A one-page document with an exact media box, built here rather than fixtured. */
  async function pageOf(box: [number, number, number, number]): Promise<Uint8Array> {
    const doc = await PDFDocument.create()
    const page = doc.addPage([box[2] - box[0], box[3] - box[1]])
    page.setMediaBox(box[0], box[1], box[2] - box[0], box[3] - box[1])
    return doc.save()
  }

  const BOXES: Array<[number, number, number, number]> = [
    [0, 0, 612, 792], // Letter, the case the fixtures already cover
    [0, 0, 595.276, 841.89], // A4 -- fractional on both axes
    [0, 0, 419.53, 595.28], // A5
    [0, 0, 100.999, 50.001], // straddles the epsilon in both directions
    [20, 30, 632.5, 822.25], // offset origin
    [-10.25, -5.5, 601.75, 786.5], // negative origin
  ]
  const DPIS = [72, 96, 150, 200, 300, 400, 72.5]

  it('predicts the exact pixel dimensions for every box and DPI', async () => {
    for (const box of BOXES) {
      const doc = PdfDocument.open(await pageOf(box))
      for (const dpi of DPIS) {
        const predicted = rasterSize(doc, 0, dpi)
        const actual = readJpeg(rasterisePage(doc, 0, dpi).bytes)
        expect(predicted, `box ${box.join(',')} at ${dpi} DPI`).toEqual(actual)
      }
      doc.close()
    }
  }, 60_000)

  /**
   * The specific values that make plain rounding wrong, kept as a
   * regression: A4 at 72 DPI is 596 pixels, not the 595 that rounding
   * 595.276 gives.
   */
  it('ceils with the engine\'s epsilon rather than rounding', () => {
    expect(rasterPixels(595.276, 72)).toBe(596)
    expect(rasterPixels(841.89, 72)).toBe(842)
    // Just past a whole number: the epsilon keeps it from gaining a pixel.
    expect(rasterPixels(50.001, 72)).toBe(50)
    expect(rasterPixels(100.999, 72)).toBe(101)
  })

  /**
   * 612 x (150/72) is 1275.0000000000002 in binary floating point, so a
   * naive ceil would add a pixel to the most common case in the product.
   */
  it('does not let floating point add a pixel to a whole-number result', () => {
    expect(rasterPixels(612, 150)).toBe(1275)
    expect(rasterPixels(792, 150)).toBe(1650)
    expect(rasterPixels(612, 300)).toBe(2550)
  })
})
