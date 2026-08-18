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
