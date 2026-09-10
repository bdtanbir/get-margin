import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replay } from '../../src/write/index.js'
import { hashText } from '../../src/write/objects/patch.js'
import {
  emptyEditDocument,
  type EditDocument, type EditObject, type RegionPatchObject, type TextPatchObject,
} from '../../src/write/types.js'
import { generateFixtures, fixturePath, type FixtureName } from '../fixtures/index.js'
import { PdfDocument, renderPage } from '../../src/index.js'
import { buildQuadIndex } from '../../src/text/index.js'

/**
 * PATCHING A TURNED PAGE.
 *
 * `patch` and `coverArea` are the only two writers whose geometry comes from
 * EXTRACTION rather than from a stored rect, so they are the only two that
 * have to convert MuPDF page space (Convention C) into content space
 * themselves. Both used to do it as a y-flip against the UNROTATED CropBox
 * height -- which is the whole conversion when /Rotate is 0, and neither the
 * right place nor the right orientation when it is not.
 *
 * The bug that prompted this file: an invoice with MediaBox [0 0 420 595]
 * and /Rotate 90 exported with every patched line drawn at a right angle to
 * the document, overlapping the text it was supposed to replace, and with
 * the covers missing the page altogether. Every existing patch test ran on
 * an unrotated page, so all of them passed.
 *
 * The two claims here are separate and a fix can get one without the other:
 *   POSITION    -- the cover lands on the line it is hiding.
 *   ORIENTATION -- the redraw runs the same way the original run ran.
 */

beforeAll(async () => { await generateFixtures() }, 60_000)

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const FONTS = new Map([
  ['Inter', new Uint8Array(readFileSync(join(ROOT, 'apps/web/public/fonts/Inter.ttf')))],
])
const bytes = (n: FixtureName): Uint8Array => new Uint8Array(readFileSync(fixturePath(n)))

type Line = {
  text: string
  bbox: { x0: number; y0: number; x1: number; y1: number }
  dir: { x: number; y: number }
}

/** Every line of a page, in MuPDF page space -- the space the writers convert FROM. */
function linesOf(pdf: Uint8Array, page = 0): Line[] {
  const doc = PdfDocument.open(pdf)
  try {
    return buildQuadIndex(doc, page).lines.map((l) => ({
      text: l.chars.map((c) => c.char).join(''),
      bbox: { x0: l.bbox[0], y0: l.bbox[1], x1: l.bbox[2], y1: l.bbox[3] },
      dir: lineDirection(l),
    }))
  } finally {
    doc.close()
  }
}

/**
 * Which way a line runs, from its first and last glyph.
 *
 * `buildQuadIndex` does not carry MuPDF's `beginLine` direction, and adding
 * it there to serve one test would put a field on a shared type for the
 * sake of an assertion. Two glyph origins say the same thing.
 */
function lineDirection(l: { chars: Array<{ quad: number[] }> }): { x: number; y: number } {
  const first = l.chars[0]?.quad
  const last = l.chars[l.chars.length - 1]?.quad
  if (!first || !last || l.chars.length < 2) return { x: 1, y: 0 }
  const dx = (last[0]! + last[6]!) / 2 - (first[0]! + first[6]!) / 2
  const dy = (last[1]! + last[7]!) / 2 - (first[1]! + first[7]!) / 2
  const len = Math.hypot(dx, dy)
  return len < 1e-9 ? { x: 1, y: 0 } : { x: dx / len, y: dy / len }
}

/**
 * RGB at a page-space point of a rendered page, or null if it is off it.
 *
 * Page space is view space at scale 1, so the point needs no conversion --
 * but a probe placed a line's own length away from a line that runs down
 * the page can leave the paper, and `null` says so rather than reading an
 * undefined byte as a passing black pixel.
 */
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

/** One source page, on its own, so the output page is always page 0. */
function docWith(sourceIndex: number, objects: EditObject[]): EditDocument {
  return {
    ...emptyEditDocument(),
    sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: ['p0'],
    pages: { p0: { sourceIndex, sourceId: 'src-0', rotation: 0, cropBox: null } },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
  }
}

const write = (src: Uint8Array, sourceIndex: number, objects: EditObject[]): Uint8Array =>
  replay(new Map([['src-0', src]]), docWith(sourceIndex, objects), { fonts: FONTS })

function textPatch(line: Line, over: Partial<TextPatchObject> = {}): TextPatchObject {
  return {
    id: 'tp1', pageId: 'p0', kind: 'textPatch',
    lineIndex: 0,
    originalHash: hashText(line.text),
    originalText: line.text,
    text: 'Xy',
    fontFamily: 'Inter', fontSize: 0, color: [0, 0, 0],
    background: [1, 1, 1], backgroundConfidence: 1,
    fit: 'overflow',
    rect: { x: 0, y: 0, w: 0, h: 0 },
    rotation: 0, z: 1, locked: false, opacity: 1,
    ...over,
  }
}

/**
 * The four pages of `rotated` plus the invoice's own shape.
 *
 * `rotated` page 1 and `rotated-upright` are BOTH /Rotate 90 and they are
 * not the same case: the first has its text along user-space +x so it
 * displays sideways (direction [0,1]), the second has it authored sideways
 * so it displays upright (direction [1,0]). A writer that simply rotated
 * every redraw by the page's /Rotate would pass one and fail the other,
 * which is why both are here.
 */
const CASES: Array<[label: string, fixture: FixtureName, page: number]> = [
  ['an unrotated page', 'rotated', 0],
  ['a quarter-turned page whose text displays sideways', 'rotated', 1],
  ['a half-turned page', 'rotated', 2],
  ['a three-quarter-turned page', 'rotated', 3],
  ['a quarter-turned page whose text displays upright', 'rotated-upright', 0],
]

describe('text patch on a turned page', () => {
  for (const [label, fixture, page] of CASES) {
    /** The line being replaced, as it was before the edit. */
    const before = (): Line => {
      const l = linesOf(bytes(fixture), page)[0]
      if (!l) throw new Error(`fixture ${fixture} page ${page} has no text`)
      return l
    }

    it(`covers the line it replaces on ${label}`, () => {
      const original = before()
      // Magenta, and nothing drawn over it: the cover alone is under test,
      // and no fixture contains magenta, so finding it is unambiguous.
      const out = write(bytes(fixture), page, [
        textPatch(original, { text: '', background: [1, 0, 1] }) as EditObject,
      ])

      const cx = (original.bbox.x0 + original.bbox.x1) / 2
      const cy = (original.bbox.y0 + original.bbox.y1) / 2
      const px = samplePixel(out, cx, cy)
      expect(px, 'the centre of the line is on the page').not.toBeNull()
      expect(px!.r, 'r at the centre of the covered line').toBeGreaterThan(180)
      expect(px!.g, 'g at the centre of the covered line').toBeLessThan(90)
      expect(px!.b, 'b at the centre of the covered line').toBeGreaterThan(180)
    })

    it(`does not paint far from the line on ${label}`, () => {
      // The positive check alone passes for a cover that swallowed the page.
      // Before the fix the cover was not merely misplaced, it was the wrong
      // SHAPE too -- page space swaps w and h on a quarter turn.
      const original = before()
      const out = write(bytes(fixture), page, [
        textPatch(original, { text: '', background: [1, 0, 1] }) as EditObject,
      ])

      const h = original.bbox.y1 - original.bbox.y0
      const w = original.bbox.x1 - original.bbox.x0
      const outside: Array<[number, number]> = [
        [original.bbox.x0 - w - 8, (original.bbox.y0 + original.bbox.y1) / 2],
        [original.bbox.x1 + w + 8, (original.bbox.y0 + original.bbox.y1) / 2],
        [(original.bbox.x0 + original.bbox.x1) / 2, original.bbox.y0 - h - 8],
        [(original.bbox.x0 + original.bbox.x1) / 2, original.bbox.y1 + h + 8],
      ]
      let probed = 0
      for (const [x, y] of outside) {
        const px = samplePixel(out, x, y)
        // A probe past the edge of the paper proves nothing either way.
        if (!px) continue
        probed++
        expect(px.g, `g at page(${Math.round(x)},${Math.round(y)})`).toBeGreaterThan(180)
      }
      expect(probed, 'every probe fell off the page').toBeGreaterThan(0)
    })

    it(`redraws along the same line on ${label}`, () => {
      const original = before()
      const out = write(bytes(fixture), page, [textPatch(original) as EditObject])

      // The original text is COVERED, not removed, so it still extracts --
      // the replacement is found by what it says.
      const replacement = linesOf(out, 0).find((l) => l.text.trim() === 'Xy')
      expect(replacement, 'the replacement was not drawn').toBeDefined()

      // ORIENTATION. A dot product of 1 is the same heading; the old code
      // scored 0 here on every turned page, drawing at a right angle.
      const dot = replacement!.dir.x * original.dir.x + replacement!.dir.y * original.dir.y
      expect(dot, `heading of "${replacement!.text}" vs the line it replaced`)
        .toBeGreaterThan(0.99)

      // POSITION. 'Xy' is shorter than every original here, so it sits
      // inside the box it replaced -- grown by a couple of points, because
      // Inter's ascent is not Helvetica's.
      const pad = 3
      expect(replacement!.bbox.x0).toBeGreaterThanOrEqual(original.bbox.x0 - pad)
      expect(replacement!.bbox.y0).toBeGreaterThanOrEqual(original.bbox.y0 - pad)
      expect(replacement!.bbox.x1).toBeLessThanOrEqual(original.bbox.x1 + pad)
      expect(replacement!.bbox.y1).toBeLessThanOrEqual(original.bbox.y1 + pad)
    })
  }

  it('shrinks to the length of the line, not to the thickness of it', () => {
    // A GUARD ON THE FIX, not a reproduction of the shipped bug: the old
    // code measured `fit` against a page-space width, which was right, and
    // was wrong only about where and which way to draw. Converting the box
    // to content space first makes `w` the thickness of the glyph band on a
    // quarter-turned page, and measuring `fit` against THAT shrinks an
    // ordinary replacement to the 4pt floor. `along` is why it does not.
    const original = linesOf(bytes('rotated-upright'), 0)[0]!
    const out = write(bytes('rotated-upright'), 0, [
      textPatch(original, { text: 'Invoice No: 1', fit: 'shrink' }) as EditObject,
    ])
    const replacement = linesOf(out, 0).find((l) => l.text.trim() === 'Invoice No: 1')
    expect(replacement).toBeDefined()
    // Set at the line's own size (14pt), so its glyph band is nowhere near
    // the floor. Anything under ~6pt means the fit rule measured the wrong axis.
    expect(replacement!.bbox.y1 - replacement!.bbox.y0).toBeGreaterThan(8)
  })
})

describe('region patch on a turned page', () => {
  /**
   * `regionPatch` carries a page-space rect the user drew and hands it
   * straight to `coverAndRedraw`, which is the same conversion `patch` needs
   * and was the same bug. A box over the first line stands in for the logo
   * this kind normally covers.
   */
  it('covers the area the user drew, on a quarter-turned page', () => {
    const src = bytes('rotated-upright')
    const line = linesOf(src, 0)[0]!
    const rect = {
      x: line.bbox.x0,
      y: line.bbox.y0,
      w: line.bbox.x1 - line.bbox.x0,
      h: line.bbox.y1 - line.bbox.y0,
    }
    const o: RegionPatchObject = {
      id: 'rp1', pageId: 'p0', kind: 'regionPatch',
      background: [1, 0, 1], backgroundConfidence: 1,
      rect,
      rotation: 0, z: 1, locked: false, opacity: 1,
    }
    const out = write(src, 0, [o as EditObject])

    const px = samplePixel(out, rect.x + rect.w / 2, rect.y + rect.h / 2)
    expect(px).not.toBeNull()
    expect(px!.r).toBeGreaterThan(180)
    expect(px!.g).toBeLessThan(90)
    expect(px!.b).toBeGreaterThan(180)

    // And the second line, well clear of the box, is untouched.
    const other = linesOf(src, 0)[1]!
    const clear = samplePixel(out, other.bbox.x1 + 20, (other.bbox.y0 + other.bbox.y1) / 2)
    expect(clear).not.toBeNull()
    expect(clear!.g).toBeGreaterThan(180)
  })
})
