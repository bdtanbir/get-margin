import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import * as mupdf from 'mupdf'
import { replay } from '../../src/write/index.js'
import { resolveTokens, batesNumber } from '../../src/write/objects/stamp.js'
import {
  emptyEditDocument, type EditDocument, type EditObject, type StampObject,
} from '../../src/write/types.js'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateFixtures, fixturePath, type FixtureName } from '../fixtures/index.js'
import { PdfDocument } from '../../src/index.js'
import { buildQuadIndex } from '../../src/text/index.js'
import { geometryFromPageObject } from '../../src/geometry.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: FixtureName): Uint8Array => new Uint8Array(readFileSync(fixturePath(n)))

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const FONTS = new Map([[
  'Inter', new Uint8Array(readFileSync(join(ROOT, 'apps/web/public/fonts/Inter.ttf'))),
]])

function docWith(objects: EditObject[], pages = 1): EditDocument {
  return {
    ...emptyEditDocument(),
    sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: Array.from({ length: pages }, (_, i) => `p${i}`),
    pages: Object.fromEntries(Array.from({ length: pages }, (_, i) => [
      `p${i}`, { sourceIndex: i, sourceId: 'src-0', rotation: 0, cropBox: null },
    ])),
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    nextZ: 99,
  }
}

function stamp(over: Partial<StampObject> = {}): StampObject {
  return {
    id: 's1', pageId: 'p0', kind: 'stamp',
    rect: { x: 100, y: 60, w: 400, h: 24 },
    rotation: 0, z: 1, locked: false, opacity: 1,
    stampKind: 'footer', text: 'Page 1 of 3',
    fontFamily: 'Inter', fontSize: 12, color: [0, 0, 0], align: 'left',
    behind: false,
    ...over,
  }
}

const write = (objects: EditObject[], fixture: FixtureName = 'simple-text', pages = 1) =>
  replay(new Map([['src-0', bytes(fixture)]]), docWith(objects, pages), { fonts: FONTS })

function pageText(pdf: Uint8Array, page = 0): string {
  const d = PdfDocument.open(pdf)
  try {
    return buildQuadIndex(d, page).lines.flatMap((l) => l.chars).map((c) => c.char).join('')
  } finally { d.close() }
}

/** Where a stamp's glyphs actually landed, in MuPDF page space. */
function stampBounds(pdf: Uint8Array, needle: string, page = 0) {
  const d = PdfDocument.open(pdf)
  try {
    const chars = buildQuadIndex(d, page).lines.flatMap((l) => l.chars)
    const text = chars.map((c) => c.char).join('')
    const at = text.indexOf(needle)
    if (at === -1) return null
    const quads = chars.slice(at, at + needle.length).map((c) => c.quad)
    const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]])
    const ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]])
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
  } finally { d.close() }
}

describe('resolveTokens', () => {
  const ctx = { pageNumber: 3, pageCount: 12, fileName: 'report.pdf', date: '2026-08-19', bates: 'ACME-000042' }

  it('resolves every token', () => {
    expect(resolveTokens('{n} of {total}', ctx)).toBe('3 of 12')
    expect(resolveTokens('{filename} — {date}', ctx)).toBe('report.pdf — 2026-08-19')
    expect(resolveTokens('{bates}', ctx)).toBe('ACME-000042')
  })

  it('resolves several in one template', () => {
    expect(resolveTokens('{filename} page {n}/{total}', ctx)).toBe('report.pdf page 3/12')
  })

  it('leaves text with no tokens alone', () => {
    expect(resolveTokens('CONFIDENTIAL', ctx)).toBe('CONFIDENTIAL')
  })

  /**
   * A user who typed {page} instead of {n} should see their mistake on the
   * page rather than a silent gap they have to infer from an empty footer.
   */
  it('leaves an unknown token visible rather than blanking it', () => {
    expect(resolveTokens('{page} of {total}', ctx)).toBe('{page} of 12')
  })
})

describe('batesNumber', () => {
  const opts = { start: 1, step: 1, digits: 6, prefix: 'ACME-', suffix: '' }

  it('pads to the requested width', () => {
    expect(batesNumber(0, opts)).toBe('ACME-000001')
    expect(batesNumber(41, opts)).toBe('ACME-000042')
  })

  it('honours start and step', () => {
    expect(batesNumber(0, { ...opts, start: 500 })).toBe('ACME-000500')
    expect(batesNumber(3, { ...opts, start: 100, step: 10 })).toBe('ACME-000130')
  })

  it('carries a suffix', () => {
    expect(batesNumber(0, { ...opts, suffix: '-CONF' })).toBe('ACME-000001-CONF')
  })

  // The sequence must be unbroken and predictable across a production.
  it('never repeats within a run', () => {
    const seen = new Set(Array.from({ length: 50 }, (_, i) => batesNumber(i, opts)))
    expect(seen.size).toBe(50)
  })
})

describe('stamp writer', () => {
  it('draws its text onto the page', () => {
    expect(pageText(write([stamp({ text: 'CONFIDENTIAL' })]))).toContain('CONFIDENTIAL')
  })

  /**
   * A watermark a reader can select and delete is not a watermark. This is
   * the deliberate opposite of the ink and markup writers, which stay as
   * native annotations so they REMAIN editable.
   */
  it('is page content, not an annotation', () => {
    const out = write([stamp({ text: 'CONFIDENTIAL' })])
    const doc = mupdf.PDFDocument.openDocument(out, 'application/pdf') as mupdf.PDFDocument
    const p = doc.loadPage(0)
    try {
      expect(p.getAnnotations()).toHaveLength(0)
      expect(p.getWidgets()).toHaveLength(0)
    } finally { p.destroy(); doc.destroy() }
  })

  it('leaves the page’s own text intact', () => {
    const out = write([stamp({ text: 'CONFIDENTIAL' })])
    expect(pageText(out)).toContain('Hello margin')
  })

  it('draws one stamp per page across a document', () => {
    const out = write([
      stamp({ id: 'a', pageId: 'p0', text: 'Page 1' }),
      stamp({ id: 'b', pageId: 'p1', text: 'Page 2' }),
    ], 'rotated', 2)
    expect(pageText(out, 0)).toContain('Page 1')
    expect(pageText(out, 1)).toContain('Page 2')
    expect(pageText(out, 0)).not.toContain('Page 2')
  })

  it('draws nothing for empty text', () => {
    const before = pageText(bytes('simple-text'))
    expect(pageText(write([stamp({ text: '' })]))).toBe(before)
  })
})

/**
 * Geometry, with exact bounds rather than containment -- the lesson from
 * Phase 5's field writer, where a wrong space still landed inside the page
 * and three of four rotations passed a containment check.
 */
describe('stamp geometry', () => {
  it('lands where it was placed on an unrotated page', () => {
    const out = write([stamp({ text: 'FOOTER', rect: { x: 100, y: 60, w: 400, h: 24 } })])
    const b = stampBounds(out, 'FOOTER')!
    expect(b.x0).toBeCloseTo(100, 0)
    // Page space is top-down: a box 60pt from the bottom of a 792pt page has
    // its top at 792 - 84 = 708.
    expect(b.y0).toBeGreaterThan(700)
    expect(b.y1).toBeLessThan(740)
  })

  it('lands on the page on every rotation', () => {
    const out = write([0, 1, 2, 3].map((i) => stamp({
      id: `s${i}`, pageId: `p${i}`, text: `MARK${i}`, rect: { x: 60, y: 60, w: 300, h: 24 },
    })), 'rotated', 4)
    for (const i of [0, 1, 2, 3]) {
      const b = stampBounds(out, `MARK${i}`, i)
      expect(b, `page ${i}`).not.toBeNull()
      const doc = mupdf.PDFDocument.openDocument(out, 'application/pdf') as mupdf.PDFDocument
      const p = doc.loadPage(i)
      const [px0, py0, px1, py1] = p.getBounds()
      p.destroy(); doc.destroy()
      expect(b!.x0, `page ${i} x`).toBeGreaterThanOrEqual(px0! - 1)
      expect(b!.x1, `page ${i} x`).toBeLessThanOrEqual(px1! + 1)
      expect(b!.y0, `page ${i} y`).toBeGreaterThanOrEqual(py0! - 1)
      expect(b!.y1, `page ${i} y`).toBeLessThanOrEqual(py1! + 1)
    }
  })

  /**
   * A stamp's rect is RAW user space, so on a page whose CropBox does not
   * start at the origin it has to be placed relative to that origin -- the
   * same rule Phase 5's field writer follows. Placing it at a guessed
   * coordinate puts it off-page, which is not a bug in the writer.
   */
  it('lands inside an offset CropBox when placed relative to it', () => {
    const src = bytes('offset-cropbox')
    const doc = mupdf.PDFDocument.openDocument(src, 'application/pdf') as mupdf.PDFDocument
    const p = doc.loadPage(0)
    const [ox, oy] = geometryFromPageObject(p.getObject()).cropBox
    p.destroy(); doc.destroy()

    const out = replay(new Map([['src-0', src]]), docWith([
      stamp({ text: 'EDGE', rect: { x: ox + 20, y: oy + 20, w: 200, h: 20 } }),
    ]), { fonts: FONTS })
    expect(pageText(out)).toContain('EDGE')
  })

  it('centres and right-aligns within its box', () => {
    const box = { x: 100, y: 400, w: 400, h: 24 }
    const left = stampBounds(write([stamp({ text: 'ALIGN', rect: box, align: 'left' })]), 'ALIGN')!
    const centre = stampBounds(write([stamp({ text: 'ALIGN', rect: box, align: 'center' })]), 'ALIGN')!
    const right = stampBounds(write([stamp({ text: 'ALIGN', rect: box, align: 'right' })]), 'ALIGN')!
    expect(centre.x0).toBeGreaterThan(left.x0)
    expect(right.x0).toBeGreaterThan(centre.x0)
    expect(right.x1).toBeCloseTo(500, -1)
  })

  it('rotates about its own centre, so it stays on the page', () => {
    const out = write([stamp({
      text: 'DIAGONAL', rotation: 45, rect: { x: 150, y: 350, w: 300, h: 40 },
    })])
    const b = stampBounds(out, 'DIAGONAL')
    expect(b).not.toBeNull()
    expect(b!.x0).toBeGreaterThan(0)
    expect(b!.y0).toBeGreaterThan(0)
    expect(b!.x1).toBeLessThan(612)
    expect(b!.y1).toBeLessThan(792)
  })
})

/**
 * The half an ordinary append cannot express. Both orders are wanted: a
 * header belongs on top, a watermark usually beneath what it marks.
 */
describe('behind', () => {
  const contentsOrder = (pdf: Uint8Array): number => {
    const doc = mupdf.PDFDocument.openDocument(pdf, 'application/pdf') as mupdf.PDFDocument
    const p = doc.loadPage(0)
    try {
      const contents = p.getObject().get('Contents')
      return contents.isArray() ? contents.length : 1
    } finally { p.destroy(); doc.destroy() }
  }

  it('produces a content array either way', () => {
    expect(contentsOrder(write([stamp({ text: 'OVER', behind: false })]))).toBeGreaterThan(1)
    expect(contentsOrder(write([stamp({ text: 'UNDER', behind: true })]))).toBeGreaterThan(1)
  })

  it('puts a behind stamp first in the content array', () => {
    const out = write([stamp({ text: 'UNDER', behind: true })])
    const doc = mupdf.PDFDocument.openDocument(out, 'application/pdf') as mupdf.PDFDocument
    const p = doc.loadPage(0)
    try {
      const contents = p.getObject().get('Contents')
      // The stamp's stream is the FIRST entry; the page's original content
      // follows it, so the page paints over the stamp.
      const first = contents.get(0)
      expect(first.isStream()).toBe(true)
      expect(first.readStream().asString()).toContain('UNDER')
    } finally { p.destroy(); doc.destroy() }
  })

  it('puts an over stamp last', () => {
    const out = write([stamp({ text: 'OVER', behind: false })])
    const doc = mupdf.PDFDocument.openDocument(out, 'application/pdf') as mupdf.PDFDocument
    const p = doc.loadPage(0)
    try {
      const contents = p.getObject().get('Contents')
      const last = contents.get(contents.length - 1)
      expect(last.readStream().asString()).toContain('OVER')
    } finally { p.destroy(); doc.destroy() }
  })

  it('renders both, whichever order', () => {
    expect(pageText(write([stamp({ text: 'UNDER', behind: true })]))).toContain('UNDER')
    expect(pageText(write([stamp({ text: 'OVER', behind: false })]))).toContain('OVER')
  })
})
