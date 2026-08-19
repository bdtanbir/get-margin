import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { PdfDocument, renderPage } from '../../src/index.js'
import { pdfToView, type PageGeometry } from '@margin/transform'
import { withDocument, withPage, SAVE_OPTIONS } from '../../src/write/session.js'
import { appendContent, fillColor } from '../../src/write/content.js'
import { toAnnotSpace, toContentSpace, num } from '../../src/write/coords.js'

import { generateFixtures, fixturePath, type FixtureName } from '../fixtures/index.js'

// Every pdf-core test bootstraps fixtures this way -- they are generated,
// not committed, so reading the path directly without this fails on a clean
// checkout. Matches test/golden.test.ts and test/render.test.ts.
beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: FixtureName): Uint8Array => new Uint8Array(readFileSync(fixturePath(n)))

/** RGBA at a view-space point of a page rendered at scale 1. */
function samplePixel(pdf: Uint8Array, page: number, vx: number, vy: number) {
  const doc = PdfDocument.open(pdf)
  try {
    const { width, rgba } = renderPage(doc, page, 1)
    const i = (Math.round(vy) * width + Math.round(vx)) * 4
    return { r: rgba[i]!, g: rgba[i + 1]!, b: rgba[i + 2]! }
  } finally {
    doc.close()
  }
}

function geometryOf(pdf: Uint8Array, page: number): PageGeometry {
  const doc = PdfDocument.open(pdf)
  try {
    return doc.pageGeometry(page)
  } finally {
    doc.close()
  }
}

/** Draw an opaque red rect at `rect` (raw PDF space) and save. */
function drawRedRect(
  src: Uint8Array,
  page: number,
  rect: { x: number; y: number; w: number; h: number },
): Uint8Array {
  return withDocument(src, (_doc, raw) =>
    withPage(raw, page, (p) => {
      const r = toContentSpace(rect)
      appendContent(raw, p, `${fillColor([1, 0, 0])} ${num(r.x)} ${num(r.y)} ${num(r.w)} ${num(r.h)} re f`)
      return raw.saveToBuffer(SAVE_OPTIONS).asUint8Array()
    }),
  )
}

// CONVENTION B. The claim under test: a content-stream `re` operator takes
// raw, unrotated, bottom-up PDF user space with the CropBox origin NOT
// normalised. If that is wrong, these three cases disagree with each other
// -- an origin-zero page alone would not catch it.
describe('Convention B — content-stream operators use raw PDF user space', () => {
  const cases: Array<[string, FixtureName, number]> = [
    ['origin-zero letter page', 'simple-text', 0],
    ['non-zero CropBox origin', 'offset-cropbox', 0],
    ['quarter-turned page', 'rotated', 1],
  ]

  for (const [label, fixture, pageIndex] of cases) {
    it(`lands where pdfToView predicts on a ${label}`, () => {
      const src = bytes(fixture)
      const g = geometryOf(src, pageIndex)
      // Place the rect inside the CropBox regardless of its origin.
      const rect = { x: g.cropBox[0] + 60, y: g.cropBox[1] + 60, w: 80, h: 40 }

      const out = drawRedRect(src, pageIndex, rect)

      // Centre of the rect, mapped through the SAME transform the on-screen
      // overlay uses. Preview and export agreeing is the whole point.
      const centre = pdfToView({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, g, 1)
      const px = samplePixel(out, pageIndex, centre.x, centre.y)

      expect(px.r).toBeGreaterThan(200)
      expect(px.g).toBeLessThan(60)
      expect(px.b).toBeLessThan(60)
    })

    it(`does not paint just outside the rect on a ${label}`, () => {
      // The positive assertion alone passes for any transform that happens
      // to cover the sample point -- a rect landing 10x too large would
      // still be red at the centre. Sampling 6pt outside each edge pins the
      // EXTENT as well as the position.
      const src = bytes(fixture)
      const g = geometryOf(src, pageIndex)
      const rect = { x: g.cropBox[0] + 60, y: g.cropBox[1] + 60, w: 80, h: 40 }
      const out = drawRedRect(src, pageIndex, rect)

      const outside = [
        { x: rect.x - 6, y: rect.y + rect.h / 2 },
        { x: rect.x + rect.w + 6, y: rect.y + rect.h / 2 },
        { x: rect.x + rect.w / 2, y: rect.y - 6 },
        { x: rect.x + rect.w / 2, y: rect.y + rect.h + 6 },
      ]
      for (const p of outside) {
        const v = pdfToView(p, g, 1)
        const px = samplePixel(out, pageIndex, v.x, v.y)
        // Blank fixture margin: white. Red would mean the rect overshot.
        expect(px.g, `g at pdf(${p.x},${p.y})`).toBeGreaterThan(200)
      }
    })
  }

  it('leaves the existing page content intact', () => {
    const src = bytes('simple-text')
    // Draw well away from the text, then confirm the text still renders by
    // comparing total ink against the untouched original.
    const out = drawRedRect(src, 0, { x: 20, y: 20, w: 30, h: 20 })
    // "Ink" = any non-near-white pixel. Counting only a dark RED channel
    // would miss the red rect entirely (r=255), so test both directions of
    // the claim: ink must GROW by roughly the rect's area, which fails both
    // if the append drew nothing and if it clobbered the original stream.
    const inkOf = (pdf: Uint8Array): number => {
      const doc = PdfDocument.open(pdf)
      try {
        const { rgba } = renderPage(doc, 0, 1)
        let n = 0
        for (let i = 0; i < rgba.length; i += 4) {
          if (rgba[i]! < 200 || rgba[i + 1]! < 200 || rgba[i + 2]! < 200) n++
        }
        return n
      } finally {
        doc.close()
      }
    }
    const before = inkOf(src)
    const after = inkOf(out)
    expect(before).toBeGreaterThan(0)
    // 30x20pt at scale 1 = 600px, plus antialiased edges.
    expect(after - before).toBeGreaterThanOrEqual(600)
    expect(after - before).toBeLessThan(800)
  })
})

// CONVENTION A. Phase 0 measured this; the test exists so a MuPDF upgrade
// that changes the binding's y-flip behaviour fails loudly here rather than
// silently misplacing every highlight in the product.
describe('Convention A — annotation setters use page space at scale 1', () => {
  it('round-trips a rect through setRect/getRect unchanged', () => {
    const src = bytes('simple-text')
    const g = geometryOf(src, 0)
    const rect = { x: 100, y: 200, w: 50, h: 30 }
    const expected = toAnnotSpace(rect, g)

    const got = withDocument(src, (_doc, raw) =>
      withPage(raw, 0, (p) => {
        const annot = p.createAnnotation('Square')
        try {
          annot.setRect(expected)
          annot.update()
          return annot.getRect()
        } finally {
          annot.destroy()
        }
      }),
    )

    // MuPDF inflates by the border width on all four sides, so compare with
    // a tolerance rather than exactly -- Phase 0 observed 72->71, 200->201.
    for (let i = 0; i < 4; i++) expect(got[i]).toBeCloseTo(expected[i]!, 0)
  })

  it('places a Square annotation where pdfToView predicts, on a rotated page', () => {
    const src = bytes('rotated')
    const g = geometryOf(src, 1)
    const rect = { x: 80, y: 80, w: 120, h: 60 }

    const out = withDocument(src, (_doc, raw) =>
      withPage(raw, 1, (p) => {
        const annot = p.createAnnotation('Square')
        try {
          annot.setRect(toAnnotSpace(rect, g))
          annot.setInteriorColor([0, 1, 0])
          annot.setColor([0, 1, 0])
          annot.update()
        } finally {
          annot.destroy()
        }
        return raw.saveToBuffer(SAVE_OPTIONS).asUint8Array()
      }),
    )

    const centre = pdfToView({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, g, 1)
    const px = samplePixel(out, 1, centre.x, centre.y)
    expect(px.g).toBeGreaterThan(150)
    expect(px.r).toBeLessThan(120)
  })
})

// createLink's bbox space was never checked in Phase 0 -- getURI() round-
// tripped, but nothing verified where the hotspot landed. fz_link has no /AP
// and renders nothing, so this is asserted structurally rather than by pixel.
describe('createLink bbox space', () => {
  it('round-trips both the URI and a page-space bbox', () => {
    const src = bytes('simple-text')
    const g = geometryOf(src, 0)
    const rect = { x: 100, y: 200, w: 120, h: 24 }
    const expected = toAnnotSpace(rect, g)

    const links = withDocument(src, (_doc, raw) =>
      withPage(raw, 0, (p) => {
        p.createLink(expected, 'https://example.com/a').destroy()
        return raw.saveToBuffer(SAVE_OPTIONS).asUint8Array()
      }),
    )

    const reopened = PdfDocument.open(links)
    try {
      const page = reopened._raw().loadPage(0)
      try {
        const found = page.getLinks()
        expect(found).toHaveLength(1)
        expect(found[0]!.getURI()).toBe('https://example.com/a')
        const bounds = found[0]!.getBounds()
        for (let i = 0; i < 4; i++) expect(bounds[i]).toBeCloseTo(expected[i]!, 0)
      } finally {
        page.destroy()
      }
    } finally {
      reopened.close()
    }
  })

  it('is NOT raw PDF space — the two differ by the y-flip, and page space wins', () => {
    // Pins the finding rather than the implementation: if createLink ever
    // took raw bottom-up space, the round-tripped bounds would match the
    // untransformed rect instead. That distinction is invisible on a
    // vertically centred rect, so this uses one high on the page.
    const src = bytes('simple-text')
    const g = geometryOf(src, 0)
    const rect = { x: 72, y: 700, w: 100, h: 20 }
    const pageSpace = toAnnotSpace(rect, g)
    const rawSpace: [number, number, number, number] = [
      rect.x, rect.y, rect.x + rect.w, rect.y + rect.h,
    ]
    expect(pageSpace[1]).not.toBeCloseTo(rawSpace[1], 0)

    const out = withDocument(src, (_doc, raw) =>
      withPage(raw, 0, (p) => {
        p.createLink(pageSpace, 'https://example.com/b').destroy()
        return raw.saveToBuffer(SAVE_OPTIONS).asUint8Array()
      }),
    )

    const reopened = PdfDocument.open(out)
    try {
      const page = reopened._raw().loadPage(0)
      try {
        const bounds = page.getLinks()[0]!.getBounds()
        expect(bounds[1]).toBeCloseTo(pageSpace[1], 0)
      } finally {
        page.destroy()
      }
    } finally {
      reopened.close()
    }
  })
})
