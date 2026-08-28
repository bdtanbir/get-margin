import { describe, it, expect } from 'vitest'
import * as mupdf from 'mupdf'
import { PDFDocument, PDFName, PDFOperator, PDFNumber } from 'pdf-lib'
import { pageImages } from '../../src/images/index.js'

const open = (b: Uint8Array) =>
  mupdf.PDFDocument.openDocument(b, 'application/pdf') as mupdf.PDFDocument

/** A small noise JPEG, so nothing compresses it into nothing. */
function jpeg(w: number, h: number): Uint8Array {
  const px = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false)
  const buf = px.getPixels()
  let seed = 7
  for (let i = 0; i < buf.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    buf[i] = (seed >> 7) & 0xff
  }
  const out = px.asJPEG(80)
  px.destroy()
  return out
}

/** Two photos at known places, plus text, on one page. */
async function twoPhotos(rotate = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  if (rotate) page.setRotation({ type: 'degrees', angle: rotate } as never)
  const a = await doc.embedJpg(jpeg(400, 200))
  const b = await doc.embedJpg(jpeg(120, 120))
  // Drawn bottom-left first, top-right second, so draw order and reading
  // order disagree -- the index must follow the page, not the geometry.
  page.drawImage(a, { x: 50, y: 100, width: 200, height: 100 })
  page.drawImage(b, { x: 400, y: 600, width: 60, height: 60 })
  return doc.save()
}

/**
 * A page whose only non-text content is an axial SHADING.
 *
 * The reason this fixture exists: MuPDF's structured-text device
 * rasterises a shading into a synthetic image block, so `onImageBlock`
 * reports it as an image. It is not one -- it is drawn by the content
 * stream, and covering it would leave the gradient exactly where it was.
 * Found on a real e-ticket, where the grey wash behind a table was
 * reported as a third "image" alongside the logo and the barcode.
 */
async function shadingOnly(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const ctx = doc.context
  const fn = ctx.register(ctx.obj({
    FunctionType: 2, Domain: [0, 1], C0: [1, 1, 1], C1: [0.4, 0.4, 0.4], N: 1,
  }))
  const shading = ctx.register(ctx.obj({
    ShadingType: 2, ColorSpace: 'DeviceRGB', Coords: [0, 400, 0, 700],
    Function: fn, Extend: [true, true],
  }))
  page.node.Resources()!.set(PDFName.of('Shading'), ctx.obj({ Sh0: shading }))
  page.pushOperators(
    PDFOperator.of('q' as never),
    PDFOperator.of('re' as never, [36, 400, 540, 300].map((n) => PDFNumber.of(n)) as never),
    PDFOperator.of('W' as never), PDFOperator.of('n' as never),
    PDFOperator.of('sh' as never, [PDFName.of('Sh0') as never]),
    PDFOperator.of('Q' as never),
  )
  return doc.save()
}

/** What structured text thinks the images are, for comparison. */
function structTextBoxes(page: mupdf.PDFPage): number[][] {
  const out: number[][] = []
  page.toStructuredText('preserve-images').walk({
    onImageBlock: (bbox: number[]) => { out.push([...bbox]) },
  } as never)
  return out
}

const withPage = <T>(bytes: Uint8Array, fn: (p: mupdf.PDFPage) => T): T => {
  const d = open(bytes)
  const p = d.loadPage(0) as mupdf.PDFPage
  try { return fn(p) } finally { p.destroy(); d.destroy() }
}

describe('pageImages', () => {
  it('finds every image the page draws, in draw order', async () => {
    const images = withPage(await twoPhotos(), pageImages)
    expect(images).toHaveLength(2)
    expect(images[0]!.width).toBe(400)
    expect(images[0]!.height).toBe(200)
    expect(images[1]!.width).toBe(120)
    expect(images[1]!.height).toBe(120)
    expect(images.map((i) => i.index)).toEqual([0, 1])
  })

  it('reports where an image sits, in points', async () => {
    const [first] = withPage(await twoPhotos(), pageImages)
    // Drawn at 200x100pt with its BOTTOM at y=100 on a 792pt page, so its
    // top-down box runs from 792-200=592 to 692.
    const [x0, y0, x1, y1] = first!.bbox
    expect(x0).toBeCloseTo(50, 0)
    expect(x1).toBeCloseTo(250, 0)
    expect(y0).toBeCloseTo(592, 0)
    expect(y1).toBeCloseTo(692, 0)
  })

  /**
   * The whole reason this is a device walk and not `onImageBlock`.
   * Structured text reports the shading as an image; the page draws none.
   */
  it('does not report a shading as an image', async () => {
    const bytes = await shadingOnly()
    const [images, blocks] = withPage(bytes, (p) => [pageImages(p), structTextBoxes(p)] as const)
    expect(blocks.length).toBeGreaterThan(0)
    expect(images).toEqual([])
  })

  it('agrees with structured text about where a real image is', async () => {
    const bytes = await twoPhotos()
    const [images, blocks] = withPage(bytes, (p) => [pageImages(p), structTextBoxes(p)] as const)
    expect(blocks).toHaveLength(2)
    images.forEach((img, i) => {
      img.bbox.forEach((v, k) => expect(v).toBeCloseTo(blocks[i]![k]!, 0))
    })
  })

  /**
   * Page space is CropBox-normalised with /Rotate applied, which is the
   * space every quad in the codebase already lives in. If the walk reported
   * raw user space instead, this is where it would show.
   */
  it('reports rotated pages in the same space structured text does', async () => {
    const bytes = await twoPhotos(90)
    const [images, blocks] = withPage(bytes, (p) => [pageImages(p), structTextBoxes(p)] as const)
    expect(images).toHaveLength(2)
    images.forEach((img, i) => {
      img.bbox.forEach((v, k) => expect(v).toBeCloseTo(blocks[i]![k]!, 0))
    })
  })

  it('gives each placement a hash that changes with size and position', async () => {
    const a = withPage(await twoPhotos(), pageImages)
    const b = withPage(await twoPhotos(), pageImages)
    expect(a[0]!.hash).toBe(b[0]!.hash)
    expect(a[0]!.hash).not.toBe(a[1]!.hash)
  })
})
