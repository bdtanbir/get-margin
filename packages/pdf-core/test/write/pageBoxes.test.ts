import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { replay } from '../../src/write/index.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument } from '../../src/write/types.js'
import { PdfDocument, renderPage } from '../../src/index.js'
import { generateFixtures, fixturePath, type FixtureName } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: FixtureName): Uint8Array => new Uint8Array(readFileSync(fixturePath(n)))
const SRC = 'src-0'

type Override = Partial<{ rotation: number; cropBox: [number, number, number, number] }>

/** All `pageCount` pages, with `override` applied to source page `target`. */
function docWith(pageCount: number, target: number, override: Override): EditDocument {
  return {
    version: EDIT_DOCUMENT_VERSION,
    sources: { [SRC]: { hash: '', name: 'a.pdf' } },
    pageOrder: Array.from({ length: pageCount }, (_, i) => `p${i}`),
    pages: Object.fromEntries(Array.from({ length: pageCount }, (_, i) => [
      `p${i}`,
      { sourceId: SRC, sourceIndex: i, rotation: 0, cropBox: null, ...(i === target ? override : {}) },
    ])),
    objects: {},
    nextZ: 1,
  }
}

function geometryOf(pdf: Uint8Array, i = 0) {
  const d = PdfDocument.open(pdf)
  try { return d.pageGeometry(i) } finally { d.close() }
}

describe('crop is Convention A', () => {
  // setPageBox speaks TOP-DOWN page space. A raw bottom-up rect is accepted
  // silently and lands the crop on the vertical mirror of what the user
  // drew. On a near-symmetric crop that is invisible, which is why this
  // asserts the exact box rather than eyeballing a render.
  it('writes the crop the user drew, not its vertical mirror', () => {
    // The TOP half of a 612x792 page, in raw PDF space: y 396..792, because
    // PDF space is y-up and the top of the page is the HIGH y range.
    const out = replay(new Map([[SRC, bytes('simple-text')]]), docWith(1, 0, { cropBox: [0, 396, 306, 792] }))
    const got = geometryOf(out).cropBox
    expect(got[1]).toBeCloseTo(396, 0)
    expect(got[3]).toBeCloseTo(792, 0)
    // The mirror would be y 0..396 -- assert we are NOT there.
    expect(got[1]).toBeGreaterThan(100)
  })

  it('crops correctly on a page whose CropBox origin is not zero', () => {
    const src = bytes('offset-cropbox')
    const [x0, y0] = geometryOf(src).cropBox
    const box: [number, number, number, number] = [x0 + 20, y0 + 30, x0 + 120, y0 + 130]
    const out = replay(new Map([[SRC, src]]), docWith(1, 0, { cropBox: box }))
    const got = geometryOf(out).cropBox
    for (let i = 0; i < 4; i++) expect(Math.abs(got[i]! - box[i]!)).toBeLessThan(1)
  })

  it('crops correctly on a quarter-turned page', () => {
    const box: [number, number, number, number] = [100, 200, 400, 600]
    // Page 1 of `rotated` is /Rotate 90.
    const out = replay(new Map([[SRC, bytes('rotated')]]), docWith(4, 1, { cropBox: box }))
    const got = geometryOf(out, 1).cropBox
    for (let i = 0; i < 4; i++) expect(Math.abs(got[i]! - box[i]!)).toBeLessThan(1)
  })

  // A crop re-frames the page without moving what is drawn on it.
  it('keeps page content in place, only changing the window', () => {
    const out = replay(new Map([[SRC, bytes('simple-text')]]), docWith(1, 0, { cropBox: [0, 396, 306, 792] }))
    const d = PdfDocument.open(out)
    try {
      const p = d._raw().loadPage(0)
      try {
        expect(p.toStructuredText('').asJSON()).toContain('Hello margin')
      } finally { p.destroy() }
    } finally { d.close() }
    const g = geometryOf(out)
    expect(g.cropBox[3] - g.cropBox[1]).toBeCloseTo(396, 0)
    expect(g.cropBox[2] - g.cropBox[0]).toBeCloseTo(306, 0)
  })

  it('leaves an uncropped page alone', () => {
    const out = replay(new Map([[SRC, bytes('simple-text')]]), docWith(1, 0, { cropBox: [0, 396, 306, 792] }))
    expect(geometryOf(out).cropBox[0]).toBeCloseTo(0, 0)
    const untouched = replay(new Map([[SRC, bytes('multi-page')]]), docWith(2, 0, { rotation: 90 }))
    expect(geometryOf(untouched, 1).cropBox).toEqual(geometryOf(bytes('multi-page'), 1).cropBox)
  })
})

describe('rotate', () => {
  it('adds the edit rotation to the page', () => {
    const out = replay(new Map([[SRC, bytes('simple-text')]]), docWith(1, 0, { rotation: 90 }))
    expect(geometryOf(out).rotate).toBe(90)
  })

  // Source page 1 of `rotated` is already /Rotate 90; +180 must give 270.
  it('adds to a page that is already rotated rather than replacing it', () => {
    const out = replay(new Map([[SRC, bytes('rotated')]]), docWith(4, 1, { rotation: 180 }))
    expect(geometryOf(out, 1).rotate).toBe(270)
  })

  it('wraps past 360', () => {
    // Source page 3 is /Rotate 270; +180 wraps to 90.
    const out = replay(new Map([[SRC, bytes('rotated')]]), docWith(4, 3, { rotation: 180 }))
    expect(geometryOf(out, 3).rotate).toBe(90)
  })

  // A rotated page renders with swapped dimensions -- the whole observable
  // effect, and what makes the cached bitmap stale.
  it('swaps the rendered dimensions', () => {
    const out = replay(new Map([[SRC, bytes('simple-text')]]), docWith(1, 0, { rotation: 90 }))
    const d = PdfDocument.open(out)
    try {
      const { width, height } = renderPage(d, 0, 1)
      expect(width).toBeGreaterThan(height)
    } finally { d.close() }
  })

  it('leaves other pages unrotated', () => {
    const out = replay(new Map([[SRC, bytes('multi-page')]]), docWith(3, 1, { rotation: 90 }))
    expect(geometryOf(out, 0).rotate).toBe(0)
    expect(geometryOf(out, 1).rotate).toBe(90)
    expect(geometryOf(out, 2).rotate).toBe(0)
  })

  it('applies rotation and crop together on one page', () => {
    const out = replay(
      new Map([[SRC, bytes('simple-text')]]),
      docWith(1, 0, { rotation: 90, cropBox: [0, 396, 306, 792] }),
    )
    const g = geometryOf(out)
    expect(g.rotate).toBe(90)
    expect(g.cropBox[1]).toBeCloseTo(396, 0)
  })
})
