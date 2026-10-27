import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { PdfDocument, buildQuadIndex } from '../../src/index.js'
import { replay } from '../../src/write/index.js'
import { hashText } from '../../src/write/objects/patch.js'
import { emptyEditDocument, type TextPatchObject } from '../../src/write/types.js'

/**
 * Reported: a Turnitin heading whose font another editor had overwritten
 * drew `^^/'EDEdÌ`, but editing it showed `�^�^�/�'�E�D�E�d�Ì�` -- every
 * 0x00 byte was an empty glyph MuPDF reported as U+FFFD. Sejda shows the
 * letters only, and so do we now. Export must agree, or it refuses the edit.
 */

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const inter = new Uint8Array(readFileSync(join(ROOT, 'apps/web/public/fonts/Inter-400.ttf')))

/** A one-page PDF drawing each content string as its own line in Inter. */
function pdfWith(kind: 'simple' | 'cid-no-unicode', ...lines: string[]): Uint8Array {
  const doc = new mupdf.PDFDocument()
  const font = kind === 'simple'
    ? doc.addSimpleFont(new mupdf.Font('Inter', inter), 'Latin')
    : doc.addFont(new mupdf.Font('Inter', inter))
  if (kind === 'cid-no-unicode') font.resolve().delete('ToUnicode')
  const resources = doc.addObject({ Font: { F1: font } })
  const content = lines.map((hex, i) => `BT /F1 24 Tf 10 ${150 - i * 50} Td <${hex}> Tj ET`).join('\n')
  doc.insertPage(-1, doc.addPage([0, 0, 300, 200], 0, resources, content))
  const bytes = doc.saveToBuffer('').asUint8Array().slice()
  doc.destroy()
  return bytes
}

function texts(bytes: Uint8Array): string[] {
  const doc = PdfDocument.open(bytes)
  try { return buildQuadIndex(doc, 0).lines.map((l) => l.text) } finally { doc.close() }
}

describe('characters that draw nothing', () => {
  it('leaves empty glyphs with no character out of the line', () => {
    // 0x00 has no WinAnsi character: Inter draws its empty "null" glyph.
    expect(texts(pdfWith('simple', '00480069'))).toEqual(['Hi'])
  })

  it('keeps a visible glyph that has no known character', () => {
    expect(texts(pdfWith('cid-no-unicode', '002600A7'))).toEqual(['��'])
  })

  it('never empties a line, so later lines keep their numbers', () => {
    // A line of nothing but empty glyphs keeps them rather than vanishing.
    expect(texts(pdfWith('simple', '00', '0048'))).toEqual(['�', 'H'])
  })

  it('keeps the line box, so an edit still covers everything', () => {
    const doc = PdfDocument.open(pdfWith('simple', '00480069'))
    try {
      const line = buildQuadIndex(doc, 0).lines[0]!
      expect(line.chars.map((c) => c.char).join('')).toBe('Hi')
      expect(line.bbox[0]).toBeLessThanOrEqual(10)
    } finally { doc.close() }
  })
})

describe('exporting an edit of such a line', () => {
  const bytes = pdfWith('simple', '00480069')

  function exportWith(hash: string): Uint8Array {
    const patch: TextPatchObject = {
      id: 'p1', pageId: 'p0', kind: 'textPatch', lineIndex: 0,
      originalHash: hash, originalText: 'Hi', text: 'Hello',
      fontFamily: 'Inter', fontSize: 24, color: [0, 0, 0],
      background: [1, 1, 1], backgroundConfidence: 1, fit: 'overflow',
      rect: { x: 0, y: 0, w: 0, h: 0 }, rotation: 0, z: 1, locked: false, opacity: 1,
    } as TextPatchObject
    return replay(new Map([['src-0', bytes]]), {
      ...emptyEditDocument(),
      sources: { 'src-0': { hash: '', name: 'a.pdf' } },
      pageOrder: ['p0'],
      pages: { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } },
      objects: { p1: patch },
    }, { fonts: new Map([['Inter', inter]]) })
  }

  it('applies an edit made against the line as the editor shows it', () => {
    expect(texts(exportWith(hashText('Hi')))).toContain('Hello')
  })

  it('still applies an edit saved before, against the raw text', () => {
    expect(texts(exportWith(hashText('�H�i')))).toContain('Hello')
  })

  it('still refuses an edit made against different text', () => {
    expect(() => exportWith(hashText('Bye'))).toThrow(/changed since it was edited/)
  })
})
