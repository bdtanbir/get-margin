import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import * as mupdf from 'mupdf'
import { PDFDocument } from 'pdf-lib'
import { recompressImages, PRESETS } from '../../src/write/compress.js'
import { generateFixtures, fixturePath } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const open = (b: Uint8Array) =>
  mupdf.PDFDocument.openDocument(b, 'application/pdf') as mupdf.PDFDocument

/**
 * A document carrying one large NOISE photograph.
 *
 * Noise, so nothing compresses it away and the numbers mean something --
 * and built with pdf-lib rather than the code under test, so a shared
 * misunderstanding cannot pass on both sides.
 */
async function withPhoto(w = 1600, h = 1200, quality = 92): Promise<Uint8Array> {
  const px = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false)
  const buf = px.getPixels()
  let seed = 11
  for (let i = 0; i < buf.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    buf[i] = (seed >> 7) & 0xff
  }
  const jpeg = px.asJPEG(quality)
  px.destroy()

  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const img = await doc.embedJpg(jpeg)
  page.drawImage(img, { x: 36, y: 300, width: 540, height: 405 })
  return doc.save()
}

/** The same image placed on three pages, to test the embed-once path. */
async function photoOnThreePages(): Promise<Uint8Array> {
  const px = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 1200, 900], false)
  const buf = px.getPixels()
  let seed = 5
  for (let i = 0; i < buf.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    buf[i] = (seed >> 7) & 0xff
  }
  const jpeg = px.asJPEG(92)
  px.destroy()

  const doc = await PDFDocument.create()
  const img = await doc.embedJpg(jpeg)
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([612, 792])
    page.drawImage(img, { x: 36, y: 300, width: 540, height: 405 })
  }
  return doc.save()
}

/**
 * A photo nested one level down, inside a FORM XObject.
 *
 * This is not a contrived shape: it is what a real e-ticket looks like.
 * Probing a US-Bangla e-ticket found its logo and barcode drawn from
 * inside /Fm1 and /Fm2, with the page's own /Resources /XObject holding
 * no image at all -- so a walk that reads only page-level resources
 * reports zero images and compresses nothing, on exactly the documents
 * with the most to save.
 *
 * Built with pdf-lib's `embedPdf`, which is how one document's page
 * becomes another's form -- the same construction the generators of those
 * tickets use.
 */
async function photoInsideForm(): Promise<Uint8Array> {
  const inner = await withPhoto()
  const outer = await PDFDocument.create()
  const [form] = await outer.embedPdf(inner)
  const page = outer.addPage([612, 792])
  page.drawPage(form!, { x: 0, y: 0, width: 612, height: 792 })
  return outer.save()
}

/**
 * A vector-heavy document with no images at all.
 *
 * This is the case the pre-flight measured as GROWING on re-save
 * (12,381 -> 12,687 bytes): the structure is already compact, so
 * re-serialising costs more than it saves and there are no images to win
 * it back. Exactly what the floor exists for.
 */
async function vectorHeavy(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  for (let i = 0; i < 4000; i++) {
    page.drawRectangle({ x: (i * 7) % 600, y: (i * 13) % 780, width: 3, height: 3 })
  }
  return doc.save()
}

const pageText = (pdf: Uint8Array): string => {
  const d = open(pdf)
  const p = d.loadPage(0)
  try { return p.toStructuredText().asText() } finally { p.destroy(); d.destroy() }
}

describe('recompressImages', () => {
  it('makes a photo-heavy document substantially smaller', async () => {
    const src = await withPhoto()
    const out = recompressImages(src, 'balanced')
    expect(out.keptOriginal).toBe(false)
    expect(out.imagesRecompressed).toBe(1)
    expect(out.after).toBeLessThan(out.before * 0.75)
  })

  it('squeezes harder for a smaller preset', async () => {
    const src = await withPhoto()
    const light = recompressImages(src, 'light').after
    const balanced = recompressImages(src, 'balanced').after
    const small = recompressImages(src, 'small').after
    expect(balanced).toBeLessThan(light)
    expect(small).toBeLessThan(balanced)
  })

  it('reports what it did', async () => {
    const out = recompressImages(await withPhoto(), 'small')
    expect(out.before).toBeGreaterThan(0)
    expect(out.after).toBeGreaterThan(0)
    expect(out.bytes.length).toBe(out.after)
  })

  /**
   * THE FLOOR, and the reason this feature is not a save option. The
   * pre-flight measured that re-serialising an already-well-written file
   * GROWS it. A compress button that reliably returns a larger file is
   * worse than no button.
   */
  it('hands back the original when compressing would grow it', async () => {
    const src = await vectorHeavy()
    const out = recompressImages(src, 'small')
    expect(out.imagesRecompressed).toBe(0)
    expect(out.keptOriginal).toBe(true)
    expect(Buffer.from(out.bytes).equals(Buffer.from(src))).toBe(true)
    expect(out.after).toBe(out.before)
  })

  it('reports no images for a document that has none', () => {
    const src = new Uint8Array(readFileSync(fixturePath('simple-text')))
    expect(recompressImages(src, 'balanced').imagesRecompressed).toBe(0)
  })

  it('leaves an already-tiny image alone rather than growing it', async () => {
    // Already compressed harder than the preset asks for.
    const src = await withPhoto(400, 300, 20)
    const out = recompressImages(src, 'light')
    expect(out.after).toBeLessThanOrEqual(out.before)
  })

  /**
   * The same image on ten pages is ONE stream referenced ten times.
   * Re-encoding it per page would be ten times the work AND would degrade
   * it repeatedly, since each pass would re-encode an already-lossy result.
   */
  it('re-encodes a shared image once, not once per page', async () => {
    const out = recompressImages(await photoOnThreePages(), 'balanced')
    expect(out.imagesRecompressed).toBe(1)
    expect(out.keptOriginal).toBe(false)
  })

  /**
   * The bug this guards: images nested in a form were invisible.
   *
   * `imageRefs` read only the page's own /Resources /XObject, so a
   * document that draws its images through a form -- every e-ticket and
   * every "place a PDF inside a PDF" generator -- reported zero images
   * and was handed straight back as `keptOriginal`.
   */
  it('finds an image nested inside a form XObject', async () => {
    const out = recompressImages(await photoInsideForm(), 'balanced')
    expect(out.imagesRecompressed).toBe(1)
    expect(out.keptOriginal).toBe(false)
  })

  it('keeps the document readable', async () => {
    const src = new Uint8Array(readFileSync(fixturePath('simple-text')))
    const out = recompressImages(src, 'balanced')
    expect(pageText(out.bytes)).toContain('Hello')
  })

  it('keeps the image, and its placement, after compressing', async () => {
    const out = recompressImages(await withPhoto(), 'balanced')
    const d = open(out.bytes)
    const p = d.loadPage(0)
    try {
      const xobjects = p.getObject().get('Resources').get('XObject')
      let images = 0
      xobjects.forEach((ref) => {
        if (ref.isStream() && ref.get('Subtype').asName() === 'Image') images++
      })
      expect(images).toBe(1)
    } finally { p.destroy(); d.destroy() }
  })

  it('produces a document that still renders', async () => {
    const out = recompressImages(await withPhoto(), 'small')
    const d = open(out.bytes)
    const p = d.loadPage(0)
    try {
      const pix = p.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true)
      expect(pix.getWidth()).toBeGreaterThan(0)
      pix.destroy()
    } finally { p.destroy(); d.destroy() }
  })

  it('has presets ordered from gentle to aggressive', () => {
    expect(PRESETS.light.quality).toBeGreaterThan(PRESETS.balanced.quality)
    expect(PRESETS.balanced.quality).toBeGreaterThan(PRESETS.small.quality)
    expect(PRESETS.light.maxDimension).toBeGreaterThan(PRESETS.small.maxDimension)
  })
})
