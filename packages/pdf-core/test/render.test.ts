import { describe, it, expect, beforeAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import * as mupdf from 'mupdf'
import { PdfDocument, renderPage } from '../src/index.js'
import { generateFixtures, fixturePath } from './fixtures/index.js'
import { pageViewSize } from '@margin/transform'

beforeAll(async () => { await generateFixtures() }, 60_000)

const bytes = (n: Parameters<typeof fixturePath>[0]) => new Uint8Array(readFileSync(fixturePath(n)))

describe('renderPage', () => {
  it('produces RGBA at the expected dimensions', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    const r = renderPage(doc, 0, 1)
    expect(r.width).toBe(612)
    expect(r.height).toBe(792)
    expect(r.rgba.length).toBe(612 * 792 * 4)
    doc.close()
  })

  it('scales linearly', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    const r = renderPage(doc, 0, 2)
    expect(r.width).toBe(1224)
    expect(r.height).toBe(1584)
    doc.close()
  })

  it('agrees with pageViewSize for every rotation', () => {
    // This is the assertion that catches a rotation double-application:
    // the bitmap MUST match what the view layer expects to lay out.
    const doc = PdfDocument.open(bytes('rotated'))
    for (let i = 0; i < 4; i++) {
      const expected = pageViewSize(doc.pageGeometry(i), 1)
      const r = renderPage(doc, i, 1)
      expect({ w: r.width, h: r.height }, `page ${i} rotate ${doc.pageGeometry(i).rotate}`)
        .toEqual({ w: Math.round(expected.width), h: Math.round(expected.height) })
    }
    doc.close()
  })

  it('honours a non-zero CropBox', () => {
    const doc = PdfDocument.open(bytes('offset-cropbox'))
    const r = renderPage(doc, 0, 1)
    expect(r.width).toBe(350)
    expect(r.height).toBe(420)
    doc.close()
  })

  it('renders a mostly-white page with opaque alpha', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    const r = renderPage(doc, 0, 1)
    // Sample the bottom-right region, which the fixture leaves blank.
    const x = 550, y = 750
    const i = (y * r.width + x) * 4
    expect(r.rgba[i]).toBeGreaterThan(240)
    expect(r.rgba[i + 1]).toBeGreaterThan(240)
    expect(r.rgba[i + 2]).toBeGreaterThan(240)
    expect(r.rgba[i + 3]).toBe(255)
    doc.close()
  })

  it('renders non-white pixels where content exists', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    const r = renderPage(doc, 0, 1)
    let dark = 0
    for (let i = 0; i < r.rgba.length; i += 4) if ((r.rgba[i] ?? 255) < 128) dark++
    expect(dark).toBeGreaterThan(200) // the heading alone covers more than this
    doc.close()
  })

  it('rejects an out-of-range index and a non-positive scale', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    expect(() => renderPage(doc, 5, 1)).toThrow(/range/i)
    expect(() => renderPage(doc, 0, 0)).toThrow(/scale/i)
    expect(() => renderPage(doc, 0, -1)).toThrow(/scale/i)
    doc.close()
  })

  // --- Amendment 2: the stride guard --------------------------------------
  // A padded pixmap copied as if contiguous produces a progressively sheared
  // image. Real mupdf pixmaps in this environment are unpadded, so we force
  // a lying getStride() to prove the guard actually fires.
  it('throws a clear error when the pixmap stride disagrees with width x bytesPerPixel', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    const strideSpy = vi.spyOn(mupdf.Pixmap.prototype, 'getStride').mockReturnValue(612 * 4 + 8)
    try {
      expect(() => renderPage(doc, 0, 1)).toThrow(/stride/i)
    } finally {
      strideSpy.mockRestore()
      doc.close()
    }
  })

  // --- Review finding (Important): pin the premultiplied-over-white formula
  // At a=0 and a=255, premultiplied-over-white (`src + (255-a)`) and straight
  // alpha-over-white (`src*a/255 + (255-a)`) are numerically identical, so no
  // test that only samples fully-opaque/fully-transparent pixels (as the
  // other tests here do) can tell the two formulas apart. This test fabricates
  // a partial-alpha pixel — the regime real anti-aliased glyph edges live in —
  // via a mocked getPixels(), with component/alpha values chosen so the two
  // formulas diverge by an exact, rounding-free amount.
  it('composites a partial-alpha pixel as premultiplied-over-white, not straight alpha', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    const width = 612, height = 792
    // R=50 G=100 B=150 A=204. a/255 = 0.8 exactly, so both formulas below
    // resolve to exact integers with no rounding ambiguity:
    //   premultiplied-over-white: src + (255-a)      -> 101, 151, 201
    //   straight alpha-over-white: src*a/255 + (255-a) -> 91, 131, 171
    const fabricated = new Uint8ClampedArray(width * height * 4)
    for (let p = 0; p < fabricated.length; p += 4) {
      fabricated[p] = 50
      fabricated[p + 1] = 100
      fabricated[p + 2] = 150
      fabricated[p + 3] = 204
    }
    const pixelsSpy = vi.spyOn(mupdf.Pixmap.prototype, 'getPixels').mockReturnValue(fabricated)
    try {
      const r = renderPage(doc, 0, 1)
      expect(r.rgba[0]).toBe(101)
      expect(r.rgba[1]).toBe(151)
      expect(r.rgba[2]).toBe(201)
      expect(r.rgba[3]).toBe(255)
      // Explicitly rule out the straight-alpha form so a regression to it
      // cannot slip through by coincidence.
      expect(r.rgba[0]).not.toBe(91)
      expect(r.rgba[1]).not.toBe(131)
      expect(r.rgba[2]).not.toBe(171)
    } finally {
      pixelsSpy.mockRestore()
      doc.close()
    }
  })

  // --- Review finding (Minor): cover the 3-byte RGB fallback branch --------
  it('expands a 3-byte-per-pixel RGB fallback to opaque RGBA', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    const width = 612, height = 792
    const fabricated = new Uint8ClampedArray(width * height * 3)
    for (let p = 0; p < fabricated.length; p += 3) {
      fabricated[p] = 10
      fabricated[p + 1] = 20
      fabricated[p + 2] = 30
    }
    const pixelsSpy = vi.spyOn(mupdf.Pixmap.prototype, 'getPixels').mockReturnValue(fabricated)
    // The real pixmap's stride reflects its true 4-byte layout; override it
    // to match the fabricated 3-byte buffer so the stride guard (correctly)
    // stays out of this test's way.
    const strideSpy = vi.spyOn(mupdf.Pixmap.prototype, 'getStride').mockReturnValue(width * 3)
    try {
      const r = renderPage(doc, 0, 1)
      expect(r.rgba.length).toBe(width * height * 4)
      expect(r.rgba[0]).toBe(10)
      expect(r.rgba[1]).toBe(20)
      expect(r.rgba[2]).toBe(30)
      expect(r.rgba[3]).toBe(255)
    } finally {
      strideSpy.mockRestore()
      pixelsSpy.mockRestore()
      doc.close()
    }
  })

  // --- Amendment 4 (primary, required): deterministic disposal check ------
  // An RSS-based memory test can fail to detect a missing destroy() at all
  // (see the previous task's precedent) — this spy asserts the fact directly
  // and must fail if the `finally` block's disposal calls are removed.
  it('disposes exactly one page and one pixmap per render', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    // Warm the geometry cache first: renderPage calls doc.pageGeometry()
    // internally, which (on a cache miss) loads and destroys its own page.
    // Without this, that lookup's destroy() would be counted alongside
    // renderPage's own, over-reporting the call count we're asserting.
    doc.pageGeometry(0)
    const pageDestroySpy = vi.spyOn(mupdf.Page.prototype, 'destroy')
    const pixmapDestroySpy = vi.spyOn(mupdf.Pixmap.prototype, 'destroy')
    try {
      renderPage(doc, 0, 1)
      expect(pageDestroySpy).toHaveBeenCalledTimes(1)
      expect(pixmapDestroySpy).toHaveBeenCalledTimes(1)
    } finally {
      pageDestroySpy.mockRestore()
      pixmapDestroySpy.mockRestore()
      doc.close()
    }
  })

  it('disposes the page and pixmap even when the render throws', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    doc.pageGeometry(0) // see note above: warm the cache before spying
    const pageDestroySpy = vi.spyOn(mupdf.Page.prototype, 'destroy')
    const pixmapDestroySpy = vi.spyOn(mupdf.Pixmap.prototype, 'destroy')
    const strideSpy = vi.spyOn(mupdf.Pixmap.prototype, 'getStride').mockReturnValue(999999)
    try {
      expect(() => renderPage(doc, 0, 1)).toThrow()
      expect(pageDestroySpy).toHaveBeenCalledTimes(1)
      expect(pixmapDestroySpy).toHaveBeenCalledTimes(1)
    } finally {
      strideSpy.mockRestore()
      pageDestroySpy.mockRestore()
      pixmapDestroySpy.mockRestore()
      doc.close()
    }
  })
})
