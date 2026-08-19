import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { replay } from '../../src/write/index.js'
import { emptyEditDocument, type EditDocument, type EditObject } from '../../src/write/types.js'
import { generateFixtures, fixturePath } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const INTER = new Uint8Array(readFileSync(join(ROOT, 'apps/web/public/fonts/Inter.ttf')))
const src = () => new Uint8Array(readFileSync(fixturePath('simple-text')))

function doc(text: string, align: 'left' | 'right'): EditDocument {
  const object = {
    id: 't1', pageId: 'p0', kind: 'text', text,
    fontFamily: 'Inter', fontSize: 14, color: [0, 0, 0], align,
    rect: { x: 60, y: 600, w: 400, h: 40 },
    rotation: 0, z: 1, locked: false, opacity: 1,
  } as EditObject
  return {
    ...emptyEditDocument(),
    sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: ['p0'],
    pages: { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } },
    objects: { t1: object },
  }
}

const write = (text: string, align: 'left' | 'right' = 'left') =>
  replay(new Map([['src-0', src()]]), doc(text, align), { fonts: new Map([['Inter', INTER]]) })

/** The rightmost x of the drawn text, in page space. */
function rightEdge(pdf: Uint8Array): number {
  const d = mupdf.PDFDocument.openDocument(pdf, 'application/pdf') as mupdf.PDFDocument
  const p = d.loadPage(0)
  try {
    let max = 0
    p.toStructuredText('').walk({
      onChar: (_c: unknown, _o: unknown, _f: unknown, _s: unknown, quad: number[]) => {
        for (let i = 0; i < 8; i += 2) max = Math.max(max, quad[i] ?? 0)
      },
    } as never)
    return max
  } finally { p.destroy(); d.destroy() }
}

/**
 * WHY FONT SUBSETTING IS NOT IN THIS PHASE.
 *
 * PLAN.md 2.5 defers subsetting to a pdf-lib + fontkit dependency, noting
 * that MuPDF's own `subsetFonts()` "made zero measurable difference" -- for
 * a font REGISTERED BUT NOT YET DRAWN, which has no glyph usage to subset
 * against.
 *
 * Once text IS drawn it does something dramatic: an export using one face
 * went from 33KB to 4KB, an 88% saving, with the text still extracting
 * correctly. That looked like the whole feature for one line of code.
 *
 * It is not, and this test is why. Subsetting rewrites the embedded font
 * without keeping its /Widths in step, so every glyph advance changes and
 * the text renders in the WRONG PLACE -- right-aligned text missed its box
 * edge by 113 points, and the Phase 2 golden images moved. Text extraction
 * still worked throughout, which is exactly what makes this dangerous: the
 * cheap check passes while the document is visibly wrong.
 *
 * So this test does not assert that subsetting works. It pins the reason it
 * is absent, and will fail loudly if a future MuPDF fixes the metrics --
 * at which point the saving is worth taking.
 */
describe('font subsetting is deferred, and this is the measurement', () => {
  it('subsetFonts really does shrink a drawn document', () => {
    const before = write('Hello margin')
    const d = mupdf.PDFDocument.openDocument(before, 'application/pdf') as mupdf.PDFDocument
    d.subsetFonts()
    const after = d.saveToBuffer('compress,garbage=compact').asUint8Array()
    d.destroy()
    // The prize: an order of magnitude, which is why this is worth
    // revisiting rather than forgetting.
    expect(after.length).toBeLessThan(before.length * 0.5)
  })

  it('and it moves the text, which is why it is not used', () => {
    const before = write('Hello margin', 'right')
    const edgeBefore = rightEdge(before)

    const d = mupdf.PDFDocument.openDocument(before, 'application/pdf') as mupdf.PDFDocument
    d.subsetFonts()
    const after = d.saveToBuffer('compress,garbage=compact').asUint8Array()
    d.destroy()

    // Same document, same text, same box -- and the glyphs land somewhere
    // else entirely.
    expect(Math.abs(rightEdge(after) - edgeBefore)).toBeGreaterThan(10)
  })

  /**
   * The trap in one line: the obvious check passes on a broken document.
   * Anyone verifying subsetting by extracting text would ship this.
   */
  it('while text extraction keeps working, so the cheap check does not catch it', () => {
    const before = write('Hello margin')
    const d = mupdf.PDFDocument.openDocument(before, 'application/pdf') as mupdf.PDFDocument
    d.subsetFonts()
    const after = d.saveToBuffer('compress,garbage=compact').asUint8Array()
    d.destroy()

    const r = mupdf.PDFDocument.openDocument(after, 'application/pdf') as mupdf.PDFDocument
    const p = r.loadPage(0)
    try {
      expect(p.toStructuredText().asText()).toContain('Hello margin')
    } finally { p.destroy(); r.destroy() }
  })

  it('so the export still embeds full faces, and text lands where it should', () => {
    const out = write('Hello margin', 'right')
    // Right-aligned text ends at the box's right edge, 60 + 400 = 460.
    expect(rightEdge(out)).toBeCloseTo(460, -1)
  })
})
