import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replay } from '../../src/write/index.js'
import { missingGlyphsFor } from '../../src/write/objects/patch.js'
import { emptyEditDocument, type EditObject } from '../../src/write/types.js'
import { PdfDocument, buildQuadIndex } from '../../src/index.js'
import { generateFixtures, fixturePath } from '../fixtures/index.js'

/**
 * Reported: an edited "Ì" downloaded as "ÃŒ". The content stream went to
 * MuPDF as a JavaScript string and was stored as UTF-8, so every character
 * past ASCII became two wrong letters in the one-byte font. Fonts are now
 * Type0 and text is written as glyph numbers.
 */

beforeAll(async () => { await generateFixtures() }, 60_000)

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const inter = new Uint8Array(readFileSync(join(ROOT, 'apps/web/public/fonts/Inter-400.ttf')))

function exported(text: string): string[] {
  const object = {
    id: 't', pageId: 'p0', kind: 'text', text, rect: { x: 40, y: 400, w: 500, h: 30 },
    rotation: 0, z: 1, locked: false, opacity: 1, fontFamily: 'Inter', weight: 400,
    fontSize: 14, color: [0, 0, 0], align: 'left',
  } as EditObject
  const out = replay(new Map([['src-0', new Uint8Array(readFileSync(fixturePath('simple-text')))]]), {
    ...emptyEditDocument(),
    sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: ['p0'],
    pages: { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } },
    objects: { t: object },
  }, { fonts: new Map([['Inter', inter]]) })
  const doc = PdfDocument.open(out)
  try { return buildQuadIndex(doc, 0).lines.map((l) => l.text) } finally { doc.close() }
}

describe('text the export writes', () => {
  it('keeps accents, curly quotes, dashes and currency exactly', () => {
    const text = 'Café Ì – children’s “quote” £5 €9 — naïve'
    expect(exported(text)).toContain(text)
  })

  it('keeps characters outside the old one-byte set that the font has', () => {
    // ı (dotless i) is in the bundled Inter but not in WinAnsi.
    expect(exported('Kırmızı')).toContain('Kırmızı')
  })

  it('escapes nothing into the text: brackets and backslashes survive', () => {
    expect(exported('a (b) \\c')).toContain('a (b) \\c')
  })

  it('leaves out a character the font cannot draw, rather than drawing garbage', () => {
    expect(missingGlyphsFor(inter, 'Inter', 'AЖ')).toEqual(['Ж'])
    expect(exported('AЖB')).toContain('AB')
  })
})
