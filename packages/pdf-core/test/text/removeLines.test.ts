import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { readLines, removeLines } from '../../src/text/removeLines.js'
import { PdfDocument, buildQuadIndex, renderPage } from '../../src/index.js'
import { replay } from '../../src/write/index.js'
import { hashText } from '../../src/write/objects/patch.js'
import { emptyEditDocument, type EditObject } from '../../src/write/types.js'

/**
 * Reported: editing a Turnitin heading that sat on the bottom edge of the
 * page's logo cut the logo and the running header in half -- the edit was
 * an opaque box. Lines are now taken off the page, text only.
 */

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const interBytes = new Uint8Array(readFileSync(join(ROOT, 'apps/web/public/fonts/Inter-400.ttf')))
const inter = new mupdf.Font('Inter', interBytes)
const hex = (s: string): string =>
  [...s].map((c) => inter.encodeCharacter(c.codePointAt(0)!).toString(16).padStart(4, '0')).join('')

/** A page drawn from `content`, with Inter as /F1 and a grey image as /Im1. */
function pdf(content: string, annots: (doc: mupdf.PDFDocument) => mupdf.PDFObject[] = () => []): Uint8Array {
  const doc = new mupdf.PDFDocument()
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 4, 4], false)
  pixmap.clear(90)
  const resources = doc.addObject({
    Font: { F1: doc.addFont(inter) },
    XObject: { Im1: doc.addImage(new mupdf.Image(pixmap)) },
  })
  const page = doc.addPage([0, 0, 300, 200], 0, resources, content)
  const list = annots(doc)
  if (list.length) {
    page.put('Annots', doc.newArray())
    for (const a of list) page.get('Annots').push(a)
  }
  doc.insertPage(-1, page)
  const bytes = doc.saveToBuffer('').asUint8Array().slice()
  doc.destroy()
  return bytes
}

/** Remove line `index` (in reading order) and hand back the result. */
function remove(bytes: Uint8Array, find: (t: string) => boolean): { out: Uint8Array; removed: number } {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument
  try {
    const page = doc.loadPage(0) as mupdf.PDFPage
    const lines = readLines(page)
    const target = lines.findIndex((l) => find(l.text))
    const removed = removeLines(page, lines, [target])
    return { out: doc.saveToBuffer('compress').asUint8Array().slice(), removed: removed.size }
  } finally {
    doc.destroy()
  }
}

const texts = (bytes: Uint8Array): string[] => {
  const d = PdfDocument.open(bytes)
  try { return buildQuadIndex(d, 0).lines.map((l) => l.text) } finally { d.close() }
}

/** RGB at a page-space point, rendered at scale 1. */
function pixel(bytes: Uint8Array, x: number, y: number): number[] {
  const d = PdfDocument.open(bytes)
  try {
    const { width, rgba } = renderPage(d, 0, 1)
    const i = (Math.round(y) * width + Math.round(x)) * 4
    return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!]
  } finally { d.close() }
}

describe('removeLines', () => {
  it('takes the line and leaves an image and the header it overlaps', () => {
    // Image at page-space y 40..60 (user space 140..160); the line's glyphs
    // reach up into it, and a header sits just above.
    const bytes = pdf([
      'q 60 0 0 20 20 140 cm /Im1 Do Q',
      `BT /F1 8 Tf 100 163 Td <${hex('Header kept')}> Tj ET`,
      `BT /F1 18 Tf 40 132 Td <${hex('Heading gone')}> Tj ET`,
    ].join('\n'))
    const { out, removed } = remove(bytes, (t) => t.startsWith('Heading'))
    expect(removed).toBe(1)
    expect(texts(out)).toEqual(['Header kept'])
    // Inside the image where it overlaps the line's box: still the image.
    expect(pixel(out, 50, 58)).toEqual(pixel(bytes, 30, 45))
  })

  it('takes the invisible glyphs too, even where they sit off the line\'s box', () => {
    // The Turnitin heading ended in an empty glyph and a "missing glyph" box
    // drawn with no advance: the first bounds to a point on the baseline,
    // the second sits right of its pen. Both survived aim at box centres,
    // leaving a stray "\ufffd" line in the download.
    const doc = new mupdf.PDFDocument()
    const font = doc.addSimpleFont(inter, 'Latin')
    doc.insertPage(-1, doc.addPage([0, 0, 300, 200], 0, doc.addObject({ Font: { F1: font } }),
      'BT /F1 18 Tf 20 150 Td <480069000000> Tj ET'))
    const bytes = doc.saveToBuffer('').asUint8Array().slice()
    doc.destroy()
    const { out, removed } = remove(bytes, (t) => t.includes('H'))
    expect(removed).toBe(1)
    expect(texts(out)).toEqual([])
  })

  it('puts back a link the redaction would have taken', () => {
    const bytes = pdf(`BT /F1 12 Tf 20 150 Td <${hex('Visit example.com')}> Tj ET`, (doc) => [
      doc.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [20, 140, 160, 165], A: { S: 'URI', URI: doc.newString('https://example.com') } }),
    ])
    const { out, removed } = remove(bytes, (t) => t.startsWith('Visit'))
    expect(removed).toBe(1)
    const doc = mupdf.Document.openDocument(out, 'application/pdf')
    expect(doc.loadPage(0).getLinks().map((l) => l.getURI())).toEqual(['https://example.com'])
  })

  it('leaves invisible (OCR) text, whose visible letters are part of an image', () => {
    const bytes = pdf(`BT 3 Tr /F1 12 Tf 20 150 Td <${hex('Scanned words')}> Tj ET`)
    const { out, removed } = remove(bytes, (t) => t.startsWith('Scanned'))
    expect(removed).toBe(0)
    expect(texts(out)).toEqual(['Scanned words'])
  })

  it('leaves a line set so tight that removing it would take its neighbours', () => {
    const bytes = pdf([
      `BT /F1 12 Tf 20 150 Td <${hex('Above')}> Tj ET`,
      `BT /F1 12 Tf 20 144 Td <${hex('Squeezed')}> Tj ET`,
      `BT /F1 12 Tf 20 138 Td <${hex('Below')}> Tj ET`,
    ].join('\n'))
    const { out, removed } = remove(bytes, (t) => t.startsWith('Squeezed'))
    expect(removed).toBe(0)
    expect(texts(out)).toEqual(['Above', 'Squeezed', 'Below'])
  })
})

describe('the export', () => {
  it('applies two edits on one page, though removing one renumbers the other', () => {
    const bytes = pdf([
      `BT /F1 12 Tf 20 170 Td <${hex('First line')}> Tj ET`,
      `BT /F1 12 Tf 20 150 Td <${hex('Middle line')}> Tj ET`,
      `BT /F1 12 Tf 20 130 Td <${hex('Last line')}> Tj ET`,
    ].join('\n'))
    const lines = texts(bytes)
    const patch = (lineIndex: number, text: string): EditObject => ({
      id: `p${lineIndex}`, pageId: 'p0', kind: 'textPatch', lineIndex,
      originalHash: hashText(lines[lineIndex]!), originalText: lines[lineIndex]!, text,
      fontFamily: 'Inter', fontSize: 12, color: [0, 0, 0], background: [1, 1, 1],
      backgroundConfidence: 1, fit: 'overflow', rect: { x: 0, y: 0, w: 0, h: 0 },
      rotation: 0, z: lineIndex + 1, locked: false, opacity: 1,
    } as EditObject)
    const out = replay(new Map([['src-0', bytes]]), {
      ...emptyEditDocument(),
      sources: { 'src-0': { hash: '', name: 'a.pdf' } },
      pageOrder: ['p0'],
      pages: { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } },
      objects: { p0: patch(0, 'One'), p2: patch(2, 'Three') },
    }, { fonts: new Map([['Inter', interBytes]]) })
    expect(texts(out).sort()).toEqual(['Middle line', 'One', 'Three'])
  })
})
