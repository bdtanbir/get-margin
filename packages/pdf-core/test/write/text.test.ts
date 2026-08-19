import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replay } from '../../src/write/index.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument, type EditObject } from '../../src/write/types.js'
import { PdfDocument } from '../../src/index.js'
import { assertGolden } from '../golden.js'
import { generateFixtures, fixturePath } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: Parameters<typeof fixturePath>[0]): Uint8Array =>
  new Uint8Array(readFileSync(fixturePath(n)))

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const fontFile = (f: string): Uint8Array =>
  new Uint8Array(readFileSync(join(ROOT, 'apps/web/public/fonts', f)))

const FONTS = new Map([['Inter', fontFile('Inter.ttf')]])

function docWith(objects: EditObject[]): EditDocument {
  return {
    version: EDIT_DOCUMENT_VERSION, sourceHash: '',
    pageOrder: ['p0'], pages: { p0: { sourceIndex: 0 } },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])), nextZ: 99,
  }
}

let n = 0
function textObject(
  text: string,
  align: 'left' | 'center' | 'right' = 'left',
  y = 600,
): EditObject {
  return {
    id: `t${n++}`, pageId: 'p0', kind: 'text', text,
    // Clear of the fixture's own text, which sits in the top ~130pt.
    rect: { x: 60, y, w: 400, h: 30 },
    rotation: 0, z: 1, locked: false, opacity: 1,
    fontFamily: 'Inter', fontSize: 18, color: [0, 0, 0], align,
  } as EditObject
}

function extract(pdf: Uint8Array): string {
  const doc = PdfDocument.open(pdf)
  try {
    const page = doc._raw().loadPage(0)
    try { return page.toStructuredText('').asJSON() } finally { page.destroy() }
  } finally { doc.close() }
}

describe('text writer', () => {
  it('draws text that is extractable from the exported file', () => {
    const out = replay(bytes('simple-text'), docWith([textObject('Hello margin')]), { fonts: FONTS })
    expect(extract(out)).toContain('Hello margin')
  })

  it('embeds the custom font rather than silently falling back', () => {
    const out = replay(bytes('simple-text'), docWith([textObject('Hello')]), { fonts: FONTS })
    const bare = replay(bytes('simple-text'), docWith([]), { fonts: FONTS })
    // addSimpleFont embeds the whole font program (no subsetting), so an
    // embed is unmistakable against an un-embedded baseline.
    expect(out.byteLength).toBeGreaterThan(bare.byteLength + 20_000)
  })

  it('escapes characters that would terminate a PDF string literal', () => {
    const out = replay(bytes('simple-text'), docWith([textObject('a(b)c\\d')]), { fonts: FONTS })
    // An unescaped ")" would end the string early and corrupt every operator
    // after it, so the text would not come back at all.
    expect(extract(out)).toContain('a(b)c')
  })

  it('throws a named error when the font was never provided', () => {
    expect(() => replay(bytes('simple-text'), docWith([textObject('x')]), { fonts: new Map() }))
      .toThrow(/Inter/)
  })

  it('throws when no fonts option is passed at all', () => {
    expect(() => replay(bytes('simple-text'), docWith([textObject('x')])))
      .toThrow(/Inter/)
  })

  it('writes every line of a multi-line object', () => {
    const out = replay(bytes('simple-text'), docWith([textObject('first\nsecond\nthird')]), { fonts: FONTS })
    const text = extract(out)
    for (const line of ['first', 'second', 'third']) expect(text).toContain(line)
  })

  // Alignment is computed from MuPDF's own glyph advances, so a right-aligned
  // line must actually END at the box's right edge, not merely differ from left.
  it('right-aligns against the box edge using real glyph advances', () => {
    const out = replay(bytes('simple-text'), docWith([
      textObject('short', 'right', 600),
      textObject('a much longer line', 'right', 500),
    ]), { fonts: FONTS })
    const blocks = JSON.parse(extract(out)).blocks as Array<{
      lines: Array<{ text: string; bbox: { x: number; w: number } }>
    }>
    const lines = blocks.flatMap((b) => b.lines)
    const short = lines.find((l) => l.text.includes('short'))!
    const long = lines.find((l) => l.text.includes('longer'))!
    const rightOf = (l: { bbox: { x: number; w: number } }) => l.bbox.x + l.bbox.w
    // Both end within a point of each other at the box's right edge (60+400).
    expect(Math.abs(rightOf(short) - rightOf(long))).toBeLessThan(2)
    expect(rightOf(short)).toBeGreaterThan(450)
  })

  it('centres a line within the box', () => {
    const out = replay(bytes('simple-text'), docWith([textObject('centred', 'center', 600)]), { fonts: FONTS })
    const blocks = JSON.parse(extract(out)).blocks as Array<{
      lines: Array<{ text: string; bbox: { x: number; w: number } }>
    }>
    const line = blocks.flatMap((b) => b.lines).find((l) => l.text.includes('centred'))!
    const centre = line.bbox.x + line.bbox.w / 2
    // Box spans x 60..460, so its centre is 260.
    expect(Math.abs(centre - 260)).toBeLessThan(3)
  })

  it('embeds a family only once however many objects use it', () => {
    const many = replay(bytes('simple-text'), docWith(
      Array.from({ length: 6 }, (_, i) => textObject(`line ${i}`, 'left', 600 - i * 40)),
    ), { fonts: FONTS })
    const one = replay(bytes('simple-text'), docWith([textObject('line 0')]), { fonts: FONTS })
    // Six objects add six short content fragments, not six copies of a
    // ~66KB font program.
    expect(many.byteLength).toBeLessThan(one.byteLength + 10_000)
  })

  it('matches the reviewed golden', async () => {
    await assertGolden('export-text', replay(bytes('simple-text'), docWith([
      textObject('Left aligned', 'left', 600),
      textObject('Centred', 'center', 550),
      textObject('Right aligned', 'right', 500),
      textObject('two\nlines', 'left', 400),
    ]), { fonts: FONTS }))
  })
})
