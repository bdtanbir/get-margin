import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { PdfDocument, renderPage, repairMissingGlyphs } from '../../src/index.js'
import { replay } from '../../src/write/index.js'
import { emptyEditDocument } from '../../src/write/types.js'
import { withEmptyNotdef } from '../../src/text/notdef.js'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const inter = new Uint8Array(readFileSync(join(ROOT, 'apps/web/public/fonts/Inter-400.ttf')))

/** loca[0..2] and whether the table is the long format. */
function loca(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let head = 0, at = 0
  for (let i = 0; i < view.getUint16(4); i++) {
    const r = 12 + i * 16
    const tag = String.fromCharCode(...bytes.subarray(r, r + 4))
    if (tag === 'head') head = view.getUint32(r + 8)
    if (tag === 'loca') at = view.getUint32(r + 8)
  }
  const long = view.getInt16(head + 50) === 1
  return [0, 1, 2].map((i) => (long ? view.getUint32(at + i * 4) : view.getUint16(at + i * 2)))
}

describe('withEmptyNotdef', () => {
  it('empties glyph 0 and leaves every other glyph where it was', () => {
    const [g0, g1, g2] = loca(inter)
    expect(g1).toBeGreaterThan(g0!)
    const out = withEmptyNotdef(inter)!
    expect(out.byteLength).toBe(inter.byteLength)
    expect(loca(out)).toEqual([g1, g1, g2])
  })

  it('has nothing to do for a font already patched, or not a font', () => {
    expect(withEmptyNotdef(withEmptyNotdef(inter)!)).toBeUndefined()
    expect(withEmptyNotdef(new Uint8Array([1, 2, 3]))).toBeUndefined()
  })
})

/**
 * Reported: a Turnitin page whose /F1 another editor had overwritten with
 * its own Inter drew a "NO GLYPH" box between every letter of a heading.
 * Other viewers draw nothing for a missing glyph; so do we now.
 */
describe('PdfDocument.blankMissingGlyphs', () => {
  /** A page that shows only character codes Inter has no glyph for. */
  function missingGlyphPdf(): Uint8Array {
    const doc = new mupdf.PDFDocument()
    const font = doc.addSimpleFont(new mupdf.Font('Inter', inter), 'Latin')
    const resources = doc.addObject({ Font: { F1: font } })
    const page = doc.addPage([0, 0, 200, 100], 0, resources, 'BT /F1 48 Tf 10 30 Td <00010203> Tj ET')
    doc.insertPage(-1, page)
    const bytes = doc.saveToBuffer('').asUint8Array().slice()
    doc.destroy()
    return bytes
  }

  const ink = (doc: PdfDocument): number => {
    const { rgba } = renderPage(doc, 0, 1)
    let dark = 0
    for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3]! > 0 && rgba[i]! < 128) dark++
    return dark
  }

  it('draws the box before and nothing after', () => {
    const bytes = missingGlyphPdf()
    const plain = PdfDocument.open(bytes)
    const blanked = PdfDocument.open(bytes)
    try {
      expect(ink(plain)).toBeGreaterThan(0)
      blanked.blankMissingGlyphs()
      expect(ink(blanked)).toBe(0)
    } finally {
      plain.close()
      blanked.close()
    }
  })
})

/**
 * Reported: the app showed the page clean, but the DOWNLOAD -- untouched or
 * edited -- drew "NO GLYPH" boxes in Preview and in Sejda's viewer.
 */
describe('downloads with missing-glyph boxes', () => {
  function boxPdf(): Uint8Array {
    const doc = new mupdf.PDFDocument()
    const font = doc.addSimpleFont(new mupdf.Font('Inter', inter), 'Latin')
    const resources = doc.addObject({ Font: { F1: font } })
    doc.insertPage(-1, doc.addPage([0, 0, 200, 100], 0, resources, 'BT /F1 48 Tf 10 30 Td <00010203> Tj ET'))
    const bytes = doc.saveToBuffer('').asUint8Array().slice()
    doc.destroy()
    return bytes
  }
  const rawInk = (bytes: Uint8Array): number => {
    const doc = PdfDocument.open(bytes)
    try {
      const { rgba } = renderPage(doc, 0, 1)
      let dark = 0
      for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3]! > 0 && rgba[i]! < 128) dark++
      return dark
    } finally { doc.close() }
  }

  it('repairs an untouched download that draws boxes', () => {
    const bytes = boxPdf()
    expect(rawInk(bytes)).toBeGreaterThan(0)
    const repaired = repairMissingGlyphs(bytes)
    expect(repaired).toBeDefined()
    expect(rawInk(repaired!)).toBe(0)
  })

  it('hands every other file back untouched', () => {
    const doc = new mupdf.PDFDocument()
    const font = doc.addSimpleFont(new mupdf.Font('Inter', inter), 'Latin')
    doc.insertPage(-1, doc.addPage([0, 0, 200, 100], 0, doc.addObject({ Font: { F1: font } }), 'BT /F1 24 Tf 10 30 Td (Fine) Tj ET'))
    const fine = doc.saveToBuffer('').asUint8Array().slice()
    doc.destroy()
    expect(repairMissingGlyphs(fine)).toBeUndefined()
  })

  it('repairs an edited download too', () => {
    const out = replay(new Map([['src-0', boxPdf()]]), {
      ...emptyEditDocument(),
      sources: { 'src-0': { hash: '', name: 'a.pdf' } },
      pageOrder: ['p0'],
      pages: { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } },
      objects: {},
    })
    expect(rawInk(out)).toBe(0)
  })
})
