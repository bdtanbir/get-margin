import { describe, it, expect } from 'vitest'
import * as mupdf from 'mupdf'
import { PDFDocument } from 'pdf-lib'
import { PdfDocument } from '../../src/index.js'
import { cropImage, buildImageIndex } from '../../src/images/index.js'

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

/** A red block at 50,100..250,200 (bottom-up) and a blue one higher up. */
async function twoImages(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const red = await doc.embedJpg(solid(80, 40, [220, 20, 20]))
  const blue = await doc.embedJpg(solid(80, 40, [20, 20, 220]))
  page.drawImage(red, { x: 50, y: 100, width: 200, height: 100 })
  page.drawImage(blue, { x: 50, y: 600, width: 100, height: 50 })
  return doc.save()
}

const src = await twoImages()

/** The decoded pixels of a PNG, so a crop can be checked by colour. */
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

describe('cropImage', () => {
  it('returns the image at that index, as PNG', () => {
    const out = withDoc((d) => cropImage(d, 0, 0, 1))
    expect(out).toBeDefined()
    // The PNG signature, so this is genuinely a PNG and not raw pixels.
    expect(Array.from(out!.data.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('crops to the image, not to the whole page', () => {
    const { width, height } = decode(withDoc((d) => cropImage(d, 0, 0, 1))!.data)
    // The red block is 200x100pt, so 200x100px at 1x -- not 612x792.
    expect(width).toBeCloseTo(200, -1)
    expect(height).toBeCloseTo(100, -1)
  })

  it('renders at the scale it is asked for', () => {
    const { width, height } = decode(withDoc((d) => cropImage(d, 0, 0, 3))!.data)
    expect(width).toBeCloseTo(600, -1)
    expect(height).toBeCloseTo(300, -1)
  })

  it('captures what the page actually shows there', () => {
    const { pixels, components } = decode(withDoc((d) => cropImage(d, 0, 0, 1))!.data)
    // The middle pixel of a solid red block is red.
    const middle = Math.floor(pixels.length / components / 2) * components
    expect(pixels[middle]!).toBeGreaterThan(150)
    expect(pixels[middle + 1]!).toBeLessThan(100)
  })

  it('crops the image that was asked for, not the first one', () => {
    const { pixels, components } = decode(withDoc((d) => cropImage(d, 0, 1, 1))!.data)
    const middle = Math.floor(pixels.length / components / 2) * components
    expect(pixels[middle + 2]!).toBeGreaterThan(150)
    expect(pixels[middle]!).toBeLessThan(100)
  })

  /**
   * The crop and the guard come from ONE walk. Two walks could disagree --
   * and a patch whose bytes are one image and whose hash is another is a
   * patch that refuses at export for no reason the user can see.
   */
  it('returns the placement hash alongside the pixels', () => {
    const out = withDoc((d) => cropImage(d, 0, 1, 1))
    const walked = withDoc((d) => buildImageIndex(d, 0).images[1]!)
    expect(out!.hash).toBe(walked.hash)
    expect(out!.bbox).toEqual(walked.bbox)
  })

  it('gives back nothing for an image that is not there', () => {
    expect(withDoc((d) => cropImage(d, 0, 9, 1))).toBeUndefined()
  })
})
