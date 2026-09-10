import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { replay } from '../../src/write/index.js'
import {
  emptyEditDocument, type EditDocument, type EditObject,
} from '../../src/write/types.js'
import { generateFixtures, fixturePath, type FixtureName } from '../fixtures/index.js'
import { PdfDocument, renderPage } from '../../src/index.js'
import { viewRectToPdf, type PageGeometry } from '@margin/transform'
import { buildQuadIndex } from '../../src/text/index.js'

/**
 * OBJECTS THE USER ADDED, on a turned page.
 *
 * The sibling of rotatedPatch.test.ts, and a genuinely different code path.
 * A patch gets its geometry from extraction; an added object carries a rect
 * the user dragged, already stored in content space -- so its POSITION was
 * always right. Its ORIENTATION was not: `text`, `stamp` and `image` all
 * emitted an axis-aligned `1 0 0 1 ... Tm` or `w 0 0 h ... cm`, and a
 * content stream is turned along with its page when it is displayed. Typing
 * a text box onto a /Rotate 90 invoice produced a line running down it.
 *
 * THE PROPERTY UNDER TEST IS INVARIANCE. What the user drags is a box in
 * page space, so an object placed at the same page-space box must come out
 * at the same page-space place whichever way the page is turned. That is
 * one claim, it holds for every kind at once, and it is what a user means
 * by "the export matches the preview".
 */

beforeAll(async () => { await generateFixtures() }, 60_000)

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const FONTS = new Map([
  ['Inter', new Uint8Array(readFileSync(join(ROOT, 'apps/web/public/fonts/Inter.ttf')))],
])
const bytes = (n: FixtureName): Uint8Array => new Uint8Array(readFileSync(fixturePath(n)))

/**
 * A PNG with ink in ONE corner only.
 *
 * The suite's diagonal stamp is symmetric under a half-turn, so it cannot
 * tell 180 from 0. A single marked corner distinguishes all four.
 */
function cornerPng(size = 40): Uint8Array {
  const png = new PNG({ width: size, height: size })
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const ink = x < size / 2 && y < size / 2 // top-left quadrant
      png.data[i] = ink ? 220 : 255
      png.data[i + 1] = ink ? 20 : 255
      png.data[i + 2] = ink ? 20 : 255
      png.data[i + 3] = 255
    }
  }
  return new Uint8Array(PNG.sync.write(png))
}
const CORNER = cornerPng()

function geometryOf(pdf: Uint8Array, page: number): PageGeometry {
  const doc = PdfDocument.open(pdf)
  try {
    return doc.pageGeometry(page)
  } finally {
    doc.close()
  }
}

/** RGB at a page-space point, which is view space at scale 1. */
function samplePixel(pdf: Uint8Array, px: number, py: number) {
  const doc = PdfDocument.open(pdf)
  try {
    const { width, height, rgba } = renderPage(doc, 0, 1)
    const x = Math.round(px)
    const y = Math.round(py)
    if (x < 0 || y < 0 || x >= width || y >= height) return null
    const i = (y * width + x) * 4
    return { r: rgba[i]!, g: rgba[i + 1]!, b: rgba[i + 2]! }
  } finally {
    doc.close()
  }
}

function write(src: Uint8Array, sourceIndex: number, objects: EditObject[]): Uint8Array {
  const doc: EditDocument = {
    ...emptyEditDocument(),
    sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: ['p0'],
    pages: { p0: { sourceIndex, sourceId: 'src-0', rotation: 0, cropBox: null } },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
  }
  return replay(new Map([['src-0', src]]), doc, { fonts: FONTS })
}

/**
 * A box in PAGE space that fits every case below.
 *
 * `rotated`'s pages are 612x792 unturned and so 792x612 turned; this box is
 * inside both, and inside `rotated-upright`'s 595x420 as well.
 */
const BOX = { x: 60, y: 150, w: 220, h: 40 }

/** The same box, as the rect an object actually stores. */
const rectFor = (g: PageGeometry) => viewRectToPdf(BOX, g, 1)

const CASES: Array<[label: string, fixture: FixtureName, page: number]> = [
  ['an unrotated page', 'rotated', 0],
  ['a quarter-turned page', 'rotated', 1],
  ['a half-turned page', 'rotated', 2],
  ['a three-quarter-turned page', 'rotated', 3],
  ['the invoice shape', 'rotated-upright', 0],
]

describe('added text on a turned page', () => {
  for (const [label, fixture, page] of CASES) {
    it(`reads left-to-right on ${label}`, () => {
      const src = bytes(fixture)
      const g = geometryOf(src, page)
      const out = write(src, page, [{
        id: 't1', pageId: 'p0', kind: 'text', z: 1, rotation: 0, locked: false, opacity: 1,
        rect: rectFor(g),
        text: 'Added text', fontFamily: 'Inter', fontSize: 18,
        color: [0, 0, 0], align: 'left',
      } as unknown as EditObject])

      const doc = PdfDocument.open(out)
      const line = buildQuadIndex(doc, 0).lines.find(
        (l) => l.chars.map((c) => c.char).join('').trim() === 'Added text',
      )
      doc.close()
      expect(line, 'the added text was not drawn').toBeDefined()

      // ORIENTATION: page space runs left-to-right on screen, so a line the
      // user typed advances along page-space +x whatever /Rotate says. The
      // old writer scored 0 here on all four turned cases.
      const first = line!.chars[0]!.quad
      const last = line!.chars[line!.chars.length - 1]!.quad
      const dx = (last[0]! + last[6]!) / 2 - (first[0]! + first[6]!) / 2
      const dy = (last[1]! + last[7]!) / 2 - (first[1]! + first[7]!) / 2
      const len = Math.hypot(dx, dy)
      expect(dx / len, `heading of the added line on ${label}`).toBeGreaterThan(0.99)

      /**
       * And it landed on the box the user dragged.
       *
       * Loosely: `ASCENT_RATIO` puts the baseline 0.8 em below the box top,
       * which is less than Inter's real ascent, so 18pt glyphs overhang the
       * top by about 3pt. That is the layout's own long-standing
       * approximation and not this file's business -- the EXACT claim is
       * the invariance one below.
       */
      expect(line!.bbox[0]).toBeGreaterThanOrEqual(BOX.x - 4)
      expect(line!.bbox[1]).toBeGreaterThanOrEqual(BOX.y - 4)
      expect(line!.bbox[2]).toBeLessThanOrEqual(BOX.x + BOX.w + 4)
      expect(line!.bbox[3]).toBeLessThanOrEqual(BOX.y + BOX.h + 4)
    })

    it(`places an image the same way up on ${label}`, () => {
      const src = bytes(fixture)
      const g = geometryOf(src, page)
      const out = write(src, page, [{
        id: 'i1', pageId: 'p0', kind: 'image', z: 1, rotation: 0, locked: false, opacity: 1,
        rect: rectFor(g), data: CORNER, mime: 'image/png',
      } as unknown as EditObject])

      // The red quadrant is the image's TOP-LEFT, so on screen it belongs in
      // the top-left quarter of the box -- and nowhere else. A turned CTM
      // sends it to a different corner, which is what the old one did.
      const q = (fx: number, fy: number) =>
        samplePixel(out, BOX.x + BOX.w * fx, BOX.y + BOX.h * fy)

      const topLeft = q(0.25, 0.25)
      expect(topLeft, 'the box is on the page').not.toBeNull()
      expect(topLeft!.r, `r in the box's top-left on ${label}`).toBeGreaterThan(150)
      expect(topLeft!.g, `g in the box's top-left on ${label}`).toBeLessThan(110)

      for (const [fx, fy, corner] of [
        [0.75, 0.25, 'top-right'], [0.25, 0.75, 'bottom-left'], [0.75, 0.75, 'bottom-right'],
      ] as Array<[number, number, string]>) {
        const px = q(fx, fy)
        expect(px, `the box's ${corner} is on the page`).not.toBeNull()
        expect(px!.g, `g in the box's ${corner} on ${label}`).toBeGreaterThan(150)
      }
    })

    it(`draws a stamp the same way up on ${label}`, () => {
      const src = bytes(fixture)
      const g = geometryOf(src, page)
      const out = write(src, page, [{
        id: 's1', pageId: 'p0', kind: 'stamp', z: 1, rotation: 0, locked: false, opacity: 1,
        rect: rectFor(g), text: 'Stamped', fontFamily: 'Inter', fontSize: 18,
        color: [0, 0, 0], align: 'left', behind: false,
      } as unknown as EditObject])

      const doc = PdfDocument.open(out)
      const line = buildQuadIndex(doc, 0).lines.find(
        (l) => l.chars.map((c) => c.char).join('').trim() === 'Stamped',
      )
      doc.close()
      expect(line, 'the stamp was not drawn').toBeDefined()

      const first = line!.chars[0]!.quad
      const last = line!.chars[line!.chars.length - 1]!.quad
      const dx = (last[0]! + last[6]!) / 2 - (first[0]! + first[6]!) / 2
      const dy = (last[1]! + last[7]!) / 2 - (first[1]! + first[7]!) / 2
      expect(dx / Math.hypot(dx, dy), `heading of the stamp on ${label}`).toBeGreaterThan(0.99)
      expect(line!.bbox[0]).toBeGreaterThanOrEqual(BOX.x - 2)
      expect(line!.bbox[2]).toBeLessThanOrEqual(BOX.x + BOX.w + 2)
    })
  }

  /**
   * A stamp's OWN rotation is separate from the page's and must survive it.
   *
   * `o.rotation` is degrees counter-clockwise as seen on the page, so a
   * 45-degree watermark leans up to the right. Composing it with the page's
   * turn is the one place a sign could invert unnoticed -- a watermark
   * leaning the wrong way still looks deliberate.
   */
  it('leans a rotated stamp the same way on a turned page as on a flat one', () => {
    const headings = CASES.map(([label, fixture, page]) => {
      const src = bytes(fixture)
      const g = geometryOf(src, page)
      const out = write(src, page, [{
        id: 's1', pageId: 'p0', kind: 'stamp', z: 1, rotation: 45, locked: false, opacity: 1,
        rect: rectFor(g), text: 'Watermark', fontFamily: 'Inter', fontSize: 18,
        color: [0, 0, 0], align: 'left', behind: false,
      } as unknown as EditObject])

      const doc = PdfDocument.open(out)
      const line = buildQuadIndex(doc, 0).lines.find(
        (l) => l.chars.map((c) => c.char).join('').trim() === 'Watermark',
      )
      doc.close()
      expect(line, `the stamp was not drawn on ${label}`).toBeDefined()
      const first = line!.chars[0]!.quad
      const last = line!.chars[line!.chars.length - 1]!.quad
      const dx = (last[0]! + last[6]!) / 2 - (first[0]! + first[6]!) / 2
      const dy = (last[1]! + last[7]!) / 2 - (first[1]! + first[7]!) / 2
      const len = Math.hypot(dx, dy)
      return { label, x: dx / len, y: dy / len }
    })

    for (const h of headings) {
      // 45 degrees counter-clockwise on screen: rightward, and UPWARD, which
      // in top-down page space means y decreasing.
      expect(h.x, `x heading on ${h.label}`).toBeCloseTo(Math.SQRT1_2, 1)
      expect(h.y, `y heading on ${h.label}`).toBeCloseTo(-Math.SQRT1_2, 1)
    }
  })

  /**
   * THE EXACT CLAIM: /Rotate changes nothing the user can see.
   *
   * The per-case tests above each check one rotation against the box, with
   * a tolerance loose enough to absorb the ascent approximation. This one
   * checks the rotations against EACH OTHER, where no approximation is
   * involved and the answers should agree to the last fraction of a point.
   * A quarter of a point is a fifth of a hairline; the old writer missed by
   * hundreds.
   */
  it('puts an added line in exactly the same place whichever way the page is turned', () => {
    const boxes = CASES.map(([label, fixture, page]) => {
      const src = bytes(fixture)
      const g = geometryOf(src, page)
      const out = write(src, page, [{
        id: 't1', pageId: 'p0', kind: 'text', z: 1, rotation: 0, locked: false, opacity: 1,
        rect: rectFor(g),
        text: 'Added text', fontFamily: 'Inter', fontSize: 18,
        color: [0, 0, 0], align: 'left',
      } as unknown as EditObject])
      const doc = PdfDocument.open(out)
      const line = doc && buildQuadIndex(doc, 0).lines.find(
        (l) => l.chars.map((c) => c.char).join('').trim() === 'Added text',
      )
      doc.close()
      expect(line, `no added line on ${label}`).toBeDefined()
      return { label, bbox: line!.bbox }
    })

    const reference = boxes[0]!
    for (const b of boxes.slice(1)) {
      for (let i = 0; i < 4; i++) {
        expect(b.bbox[i]!, `bbox[${i}] on ${b.label} vs ${reference.label}`)
          .toBeCloseTo(reference.bbox[i]!, 1)
      }
    }
  })
})
