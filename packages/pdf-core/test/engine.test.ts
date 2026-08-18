import { describe, it, expect, beforeAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import * as mupdf from 'mupdf'
import { PdfDocument } from '../src/index.js'
import { generateFixtures, fixturePath } from './fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)

const bytes = (n: Parameters<typeof fixturePath>[0]) => new Uint8Array(readFileSync(fixturePath(n)))

describe('PdfDocument.open', () => {
  it('reports the page count', () => {
    const doc = PdfDocument.open(bytes('multi-page'))
    expect(doc.pageCount).toBe(12)
    doc.close()
  })

  it('handles a 300-page document', () => {
    const doc = PdfDocument.open(bytes('large-300p'))
    expect(doc.pageCount).toBe(300)
    doc.close()
  })

  it('reports no password needed for a plain document', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    expect(doc.needsPassword()).toBe(false)
    doc.close()
  })

  it('throws a typed error on non-PDF input', () => {
    expect(() => PdfDocument.open(new Uint8Array([1, 2, 3, 4]))).toThrow()
  })

  it('is safe to close twice', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    doc.close()
    expect(() => doc.close()).not.toThrow()
  })

  it('rejects use after close', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    doc.close()
    expect(() => doc.pageGeometry(0)).toThrow(/closed/i)
  })
})

// --- Disposal regression: a 300-page sweep that would fail under dropped destroy() ---
//
// Engine facts: omitting page.destroy() doesn't leak slowly, it hard-crashes the WASM
// heap within a single few-hundred-page sweep — but that was measured rendering pixmaps
// (bitmap buffers). This sweep only reads the page dictionary (getObject(), no toPixmap),
// so the per-page allocation is much smaller. Measured directly (node --expose-gc, 3 runs
// each, RSS delta across a 300-page pageGeometry() sweep on large-300p):
//   with page.destroy():    +1.56MB, +1.64MB, +1.20MB
//   without page.destroy(): +1.41MB, +1.91MB, +1.56MB
// The two are statistically indistinguishable at this scale/workload — RSS is not a
// reliable disposal signal here (unlike the pixmap case), and vitest's own test run has
// no --expose-gc, so it would be strictly noisier than these numbers. An RSS-threshold
// assertion would therefore be flaky, not a real regression guard, so this test instead
// spies on the real, shared PDFPage.prototype.destroy (inherited from mupdf's Userdata
// base) and asserts it fires exactly once per loaded page — a deterministic signal that
// verifiably fails if the try/finally around page.destroy() in pageGeometry() is removed
// (confirmed by temporarily deleting that call: the spy count drops from 300 to 0).
describe('PdfDocument disposal', () => {
  it('destroys every page it loads across a 300-page sweep', () => {
    const spy = vi.spyOn(mupdf.PDFPage.prototype, 'destroy')
    try {
      const doc = PdfDocument.open(bytes('large-300p'))
      for (let i = 0; i < doc.pageCount; i++) {
        const g = doc.pageGeometry(i)
        expect(g.cropBox).toEqual([0, 0, 612, 792])
      }
      expect(spy).toHaveBeenCalledTimes(300)
      doc.close()
    } finally {
      spy.mockRestore()
    }
  })
})
