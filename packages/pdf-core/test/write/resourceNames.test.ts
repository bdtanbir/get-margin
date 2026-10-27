import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { PdfDocument, buildQuadIndex } from '../../src/index.js'
import { replay } from '../../src/write/index.js'
import { addResource } from '../../src/write/content.js'
import { hashText } from '../../src/write/objects/patch.js'
import { emptyEditDocument, type EditObject } from '../../src/write/types.js'

/**
 * Reported as a Turnitin heading turning into `^^/'EDEdÌ`. The export named
 * its fonts F1, F2... -- what Word calls its own -- and wrote them over the
 * page's, so editing one line of a Word PDF re-pointed /F1 at our Inter and
 * every other line set in the document's F1 was read through the wrong font.
 */

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const font = (f: string): Uint8Array => new Uint8Array(readFileSync(join(ROOT, 'apps/web/public/fonts', f)))
const FONTS = new Map([['Inter', font('Inter-400.ttf')], ['Tinos', font('Tinos-400.ttf')]])

/**
 * A page drawn the way Word draws one: its own /F1 is a two-byte (Type0,
 * Identity-H) font, so the same bytes read through a one-byte font mean
 * something else entirely.
 */
function wordLikePdf(): Uint8Array {
  const doc = new mupdf.PDFDocument()
  const face = new mupdf.Font('Tinos', font('Tinos-700.ttf'))
  const f1 = doc.addFont(face)
  const hex = (s: string): string =>
    [...s].map((c) => face.encodeCharacter(c).toString(16).padStart(4, '0')).join('')
  const resources = doc.addObject({ Font: { F1: f1 } })
  const content = [
    `BT /F1 20 Tf 40 250 Td <${hex('ASSIGNMENT')}> Tj ET`,
    `BT /F1 12 Tf 40 200 Td <${hex('Edit this line')}> Tj ET`,
  ].join('\n')
  doc.insertPage(-1, doc.addPage([0, 0, 400, 300], 0, resources, content))
  const bytes = doc.saveToBuffer('').asUint8Array().slice()
  doc.destroy()
  return bytes
}

function texts(bytes: Uint8Array): string[] {
  const d = PdfDocument.open(bytes)
  try { return buildQuadIndex(d, 0).lines.map((l) => l.text) } finally { d.close() }
}

function exportWith(bytes: Uint8Array, objects: EditObject[]): Uint8Array {
  return replay(new Map([['src-0', bytes]]), {
    ...emptyEditDocument(),
    sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: ['p0'],
    pages: { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
  }, { fonts: FONTS })
}

const base = { pageId: 'p0', rotation: 0, z: 1, locked: false, opacity: 1 }

describe('fonts the export adds never replace the page\'s own', () => {
  const bytes = wordLikePdf()
  const original = texts(bytes)

  it('starts from the lines it was drawn with', () => {
    expect(original).toEqual(['ASSIGNMENT', 'Edit this line'])
  })

  it('keeps every other line when a line is edited', () => {
    const out = exportWith(bytes, [{
      ...base, id: 'e1', kind: 'textPatch', lineIndex: 1,
      originalHash: hashText(original[1]!), originalText: original[1]!, text: 'Edited',
      fontFamily: 'Inter', fontSize: 12, color: [0, 0, 0], background: [1, 1, 1],
      backgroundConfidence: 1, fit: 'overflow', rect: { x: 0, y: 0, w: 0, h: 0 },
    } as EditObject])
    expect(texts(out)).toContain('ASSIGNMENT')
    expect(texts(out)).toContain('Edited')
  })

  it('keeps every line when a text box is added', () => {
    const out = exportWith(bytes, [{
      ...base, id: 't1', kind: 'text', text: 'New box', rect: { x: 40, y: 150, w: 200, h: 30 },
      fontFamily: 'Inter', weight: 400, fontSize: 12, color: [0, 0, 0], align: 'left',
    } as EditObject])
    expect(texts(out)).toEqual(expect.arrayContaining(['ASSIGNMENT', 'Edit this line', 'New box']))
  })
})

describe('addResource', () => {
  function page(): { raw: mupdf.PDFDocument; page: mupdf.PDFPage; taken: mupdf.PDFObject } {
    const raw = new mupdf.PDFDocument()
    const taken = raw.addObject({ Type: 'Font' })
    raw.insertPage(-1, raw.addPage([0, 0, 100, 100], 0, raw.addObject({ Font: { F1: taken } }), ''))
    return { raw, page: raw.loadPage(0) as mupdf.PDFPage, taken }
  }

  it('picks another name when the one asked for is taken', () => {
    const { raw, page: p, taken } = page()
    const ours = raw.addObject({ Type: 'Font' })
    expect(addResource(raw, p, 'Font', 'F1', ours)).toBe('F1_1')
    const fonts = p.getObject().get('Resources').get('Font')
    expect(fonts.get('F1').asIndirect()).toBe(taken.asIndirect())
    expect(fonts.get('F1_1').asIndirect()).toBe(ours.asIndirect())
  })

  it('reuses the name for the same object', () => {
    const { raw, page: p, taken } = page()
    expect(addResource(raw, p, 'Font', 'F1', taken)).toBe('F1')
  })

  it('keeps resources the page inherits from the page tree', () => {
    const raw = new mupdf.PDFDocument()
    const inherited = raw.addObject({ Type: 'Font' })
    raw.insertPage(-1, raw.addPage([0, 0, 100, 100], 0, raw.addObject({}), ''))
    const pageObj = raw.findPage(0)
    pageObj.delete('Resources')
    pageObj.get('Parent').put('Resources', raw.addObject({ Font: { F1: inherited } }))
    const name = addResource(raw, raw.loadPage(0) as mupdf.PDFPage, 'Font', 'F1', raw.addObject({ Type: 'Font' }))
    expect(name).toBe('F1_1')
    expect(pageObj.get('Resources').get('Font').get('F1').asIndirect()).toBe(inherited.asIndirect())
  })
})
