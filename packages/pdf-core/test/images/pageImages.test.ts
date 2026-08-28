import { describe, it, expect } from 'vitest'
import * as mupdf from 'mupdf'
import { PDFDocument, PDFName, PDFOperator, PDFNumber } from 'pdf-lib'
import { pageImages, placementHash } from '../../src/images/index.js'

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

/**
 * An image drawn through a CLIP that shows only part of it.
 *
 * Not contrived: page 2 of a real US-Bangla e-ticket draws its
 * dangerous-goods icon grid exactly this way. The placement matrix
 * describes a 360.8x119.5pt box, an active clip trims it to
 * 258.7x106.7pt, and the untrimmed box runs 15pt off the right edge of
 * the page.
 *
 * The image is placed at 100,300..300,500 and clipped to 100,300..200,400,
 * so only its bottom-left quarter is visible.
 */
async function clippedImage(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const img = await doc.embedJpg(jpeg(400, 200))
  const name = page.node.newXObject('Image', img.ref)
  const nums = (...n: number[]) => n.map((v) => PDFNumber.of(v)) as never
  page.pushOperators(
    PDFOperator.of('q' as never),
    PDFOperator.of('re' as never, nums(100, 300, 100, 100)),
    PDFOperator.of('W' as never), PDFOperator.of('n' as never),
    PDFOperator.of('cm' as never, nums(200, 0, 0, 200, 100, 300)),
    PDFOperator.of('Do' as never, [name] as never),
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

  /**
   * THE CLIP IS PART OF THE PLACEMENT.
   *
   * An image's matrix says where it would land; a clip in force says how
   * much of that actually shows. Reading the matrix alone gives a box
   * bigger than the image on screen -- which draws a selection target over
   * content the user cannot see is included, and makes the cover that
   * removes it wipe out whatever sits in the margin around it.
   */
  describe('clipped images', () => {
    it('reports the VISIBLE box, not the placement matrix', async () => {
      const [image] = withPage(await clippedImage(), pageImages)
      // Placed at 100,300..300,500 bottom-up, clipped to 100,300..200,400.
      // Top-down on a 792pt page that is 100,392..200,492.
      const [x0, y0, x1, y1] = image!.bbox
      expect(x0).toBeCloseTo(100, 0)
      expect(y0).toBeCloseTo(392, 0)
      expect(x1).toBeCloseTo(200, 0)
      expect(y1).toBeCloseTo(492, 0)
    })

    it('agrees with structured text about a clipped image', async () => {
      const bytes = await clippedImage()
      const [images, blocks] = withPage(bytes, (p) => [pageImages(p), structTextBoxes(p)] as const)
      expect(blocks).toHaveLength(1)
      images[0]!.bbox.forEach((v, k) => expect(v).toBeCloseTo(blocks[0]![k]!, 0))
    })

    it('still finds the image at all', async () => {
      expect(withPage(await clippedImage(), pageImages)).toHaveLength(1)
    })

    it('hashes the visible box, so the guard follows what the user saw', async () => {
      const image = withPage(await clippedImage(), pageImages)[0]!
      expect(image.hash).toBe(placementHash(image.width, image.height, image.bbox))
    })
  })

  it('gives each placement a hash that changes with size and position', async () => {
    const a = withPage(await twoPhotos(), pageImages)
    const b = withPage(await twoPhotos(), pageImages)
    expect(a[0]!.hash).toBe(b[0]!.hash)
    expect(a[0]!.hash).not.toBe(a[1]!.hash)
  })
})
