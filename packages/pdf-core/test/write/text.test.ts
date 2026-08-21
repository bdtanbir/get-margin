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

const FONTS = new Map([
  ['Inter', fontFile('Inter.ttf')],
  ['Inter Bold', fontFile('Inter-Bold.ttf')],
  ['Inter Italic', fontFile('Inter-Italic.ttf')],
  ['Inter Bold Italic', fontFile('Inter-BoldItalic.ttf')],
  // A serif whose italic is a genuinely different alphabet rather than a
  // metrically-matched companion. See the measurement test below.
  ['Source Serif 4', fontFile('SourceSerif4.ttf')],
  ['Source Serif 4 Italic', fontFile('SourceSerif4-Italic.ttf')],
])

function docWith(objects: EditObject[]): EditDocument {
  return {
    version: EDIT_DOCUMENT_VERSION, sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: ['p0'], pages: { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])), nextZ: 99,
  }
}

let n = 0
function textObject(
  text: string,
  align: 'left' | 'center' | 'right' = 'left',
  y = 600,
  bold?: boolean,
  italic?: boolean,
): EditObject {
  return {
    id: `t${n++}`, pageId: 'p0', kind: 'text', text,
    // Clear of the fixture's own text, which sits in the top ~130pt.
    rect: { x: 60, y, w: 400, h: 30 },
    rotation: 0, z: 1, locked: false, opacity: 1,
    fontFamily: 'Inter', bold, italic, fontSize: 18, color: [0, 0, 0], align,
  } as EditObject
}

/**
 * The style the line containing `needle` is drawn in, asked of the EXPORTED
 * file rather than of the object that produced it.
 *
 * Goes through MuPDF's own `isBold()` -- the same call the patch editor
 * relies on to inherit weight from a document it did not write. If this
 * agrees, so does that.
 */
function styleOf(
  pdf: Uint8Array,
  needle: string,
): { bold: boolean; italic: boolean } | undefined {
  const doc = PdfDocument.open(pdf)
  try {
    const page = doc._raw().loadPage(0)
    try {
      let found: { bold: boolean; italic: boolean } | undefined
      let text = ''
      let style = { bold: false, italic: false }
      page.toStructuredText('').walk({
        beginLine: () => { text = ''; style = { bold: false, italic: false } },
        onChar: (c: string, _o: number[], font: { isBold(): boolean; isItalic(): boolean }) => {
          if (text === '') style = { bold: font.isBold(), italic: font.isItalic() }
          text += c
        },
        endLine: () => { if (found === undefined && text.includes(needle)) found = style },
      } as never)
      return found
    } finally { page.destroy() }
  } finally { doc.close() }
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
    const out = replay(new Map([['src-0', bytes('simple-text')]]), docWith([textObject('Hello margin')]), { fonts: FONTS })
    expect(extract(out)).toContain('Hello margin')
  })

  it('embeds the custom font rather than silently falling back', () => {
    const out = replay(new Map([['src-0', bytes('simple-text')]]), docWith([textObject('Hello')]), { fonts: FONTS })
    const bare = replay(new Map([['src-0', bytes('simple-text')]]), docWith([]), { fonts: FONTS })
    // addSimpleFont embeds the whole font program (no subsetting), so an
    // embed is unmistakable against an un-embedded baseline.
    expect(out.byteLength).toBeGreaterThan(bare.byteLength + 20_000)
  })

  it('escapes characters that would terminate a PDF string literal', () => {
    const out = replay(new Map([['src-0', bytes('simple-text')]]), docWith([textObject('a(b)c\\d')]), { fonts: FONTS })
    // An unescaped ")" would end the string early and corrupt every operator
    // after it, so the text would not come back at all.
    expect(extract(out)).toContain('a(b)c')
  })

  it('throws a named error when the font was never provided', () => {
    expect(() => replay(new Map([['src-0', bytes('simple-text')]]), docWith([textObject('x')]), { fonts: new Map() }))
      .toThrow(/Inter/)
  })

  it('throws when no fonts option is passed at all', () => {
    expect(() => replay(new Map([['src-0', bytes('simple-text')]]), docWith([textObject('x')])))
      .toThrow(/Inter/)
  })

  it('writes every line of a multi-line object', () => {
    const out = replay(new Map([['src-0', bytes('simple-text')]]), docWith([textObject('first\nsecond\nthird')]), { fonts: FONTS })
    const text = extract(out)
    for (const line of ['first', 'second', 'third']) expect(text).toContain(line)
  })

  // Alignment is computed from MuPDF's own glyph advances, so a right-aligned
  // line must actually END at the box's right edge, not merely differ from left.
  it('right-aligns against the box edge using real glyph advances', () => {
    const out = replay(new Map([['src-0', bytes('simple-text')]]), docWith([
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
    const out = replay(new Map([['src-0', bytes('simple-text')]]), docWith([textObject('centred', 'center', 600)]), { fonts: FONTS })
    const blocks = JSON.parse(extract(out)).blocks as Array<{
      lines: Array<{ text: string; bbox: { x: number; w: number } }>
    }>
    const line = blocks.flatMap((b) => b.lines).find((l) => l.text.includes('centred'))!
    const centre = line.bbox.x + line.bbox.w / 2
    // Box spans x 60..460, so its centre is 260.
    expect(Math.abs(centre - 260)).toBeLessThan(3)
  })

  it('embeds a family only once however many objects use it', () => {
    const many = replay(new Map([['src-0', bytes('simple-text')]]), docWith(
      Array.from({ length: 6 }, (_, i) => textObject(`line ${i}`, 'left', 600 - i * 40)),
    ), { fonts: FONTS })
    const one = replay(new Map([['src-0', bytes('simple-text')]]), docWith([textObject('line 0')]), { fonts: FONTS })
    // Six objects add six short content fragments, not six copies of a
    // ~66KB font program.
    expect(many.byteLength).toBeLessThan(one.byteLength + 10_000)
  })

  /**
   * Weight.
   *
   * The property under test is not "does it look heavier" -- it is that the
   * BOLD FILE reached the document. A synthesised bold would satisfy the
   * eye and fail every one of these: it would embed no second font program,
   * measure at the regular's advance widths, and mis-place every centred
   * and right-aligned line by the difference.
   */
  describe('bold', () => {
    it('embeds the bold face as a font program of its own', () => {
      const regular = replay(new Map([['src-0', bytes('simple-text')]]), docWith([textObject('Heading')]), { fonts: FONTS })
      const both = replay(new Map([['src-0', bytes('simple-text')]]), docWith([
        textObject('Heading', 'left', 600, true),
        textObject('Body', 'left', 560),
      ]), { fonts: FONTS })
      // Two weights are two font programs, and no subsetting means the
      // second one is unmistakable rather than a rounding difference.
      expect(both.byteLength).toBeGreaterThan(regular.byteLength + 20_000)
    })

    it('refuses to fall back to the regular when the bold was not supplied', () => {
      // Silently substituting would export a heading nobody laid out, and
      // nothing downstream would report it.
      expect(() => replay(
        new Map([['src-0', bytes('simple-text')]]),
        docWith([textObject('Heading', 'left', 600, true)]),
        { fonts: new Map([['Inter', fontFile('Inter.ttf')]]) },
      )).toThrow(/Inter Bold/)
    })

    it('measures bold text at the bold face’s own advances', () => {
      // Both centred in the same box. Bold glyphs are wider, so a bold line
      // must START further left than the same string set regular -- which
      // it only does if the alignment maths read the bold file.
      const out = replay(new Map([['src-0', bytes('simple-text')]]), docWith([
        textObject('Widths', 'center', 600, true),
        textObject('Widths', 'center', 560),
      ]), { fonts: FONTS })
      const blocks = JSON.parse(extract(out)).blocks as Array<{
        lines: Array<{ text: string; bbox: { x: number; y: number; w: number } }>
      }>
      const lines = blocks.flatMap((b) => b.lines).filter((l) => l.text.includes('Widths'))
      expect(lines).toHaveLength(2)
      // Page space is top-down, so the higher object (y 600) extracts first.
      const [boldLine, regularLine] = lines as [typeof lines[0], typeof lines[0]]
      expect(boldLine.bbox.w).toBeGreaterThan(regularLine.bbox.w)
      expect(boldLine.bbox.x).toBeLessThan(regularLine.bbox.x)
      // Still centred on the box's centre, 260, despite being wider.
      expect(Math.abs(boldLine.bbox.x + boldLine.bbox.w / 2 - 260)).toBeLessThan(3)
    })

    it('reads back as bold from the exported file', () => {
      const out = replay(new Map([['src-0', bytes('simple-text')]]), docWith([
        textObject('Heading', 'left', 600, true),
      ]), { fonts: FONTS })
      expect(styleOf(out, 'Heading')?.bold).toBe(true)
    })

    it('leaves an object with no bold set drawn regular', () => {
      // Absent means regular. This is what lets every document stored
      // before weight existed replay unchanged, with no migration.
      const out = replay(new Map([['src-0', bytes('simple-text')]]), docWith([
        textObject('Heading'),
      ]), { fonts: FONTS })
      expect(styleOf(out, 'Heading')?.bold).toBe(false)
    })
  })

  /**
   * Slope.
   *
   * The same property as weight and asserted the same way: what matters is
   * that the ITALIC FILE reached the document. A synthesised oblique would
   * satisfy the eye, embed no second font program, and measure at the
   * upright's advance widths.
   */
  describe('italic', () => {
    it('reads back as italic from the exported file', () => {
      const out = replay(new Map([['src-0', bytes('simple-text')]]), docWith([
        textObject('Slanted', 'left', 600, false, true),
      ]), { fonts: FONTS })
      expect(styleOf(out, 'Slanted')).toEqual({ bold: false, italic: true })
    })

    it('combines with bold as a fourth face, not bold on a slant', () => {
      const out = replay(new Map([['src-0', bytes('simple-text')]]), docWith([
        textObject('Emphatic', 'left', 600, true, true),
      ]), { fonts: FONTS })
      expect(styleOf(out, 'Emphatic')).toEqual({ bold: true, italic: true })
    })

    it('embeds a font program per face, so four styles are four programs', () => {
      const one = replay(new Map([['src-0', bytes('simple-text')]]), docWith([
        textObject('One', 'left', 600),
      ]), { fonts: FONTS })
      const four = replay(new Map([['src-0', bytes('simple-text')]]), docWith([
        textObject('One', 'left', 600),
        textObject('Two', 'left', 560, true),
        textObject('Three', 'left', 520, false, true),
        textObject('Four', 'left', 480, true, true),
      ]), { fonts: FONTS })
      // Three more font programs at ~66KB each, with no subsetting.
      expect(four.byteLength).toBeGreaterThan(one.byteLength + 60_000)
    })

    it('refuses to fall back when the bold italic was not supplied', () => {
      expect(() => replay(
        new Map([['src-0', bytes('simple-text')]]),
        docWith([textObject('Emphatic', 'left', 600, true, true)]),
        { fonts: new Map([['Inter', fontFile('Inter.ttf')]]) },
      )).toThrow(/Inter Bold Italic/)
    })

    /**
     * SOURCE SERIF 4, not Inter, and the choice IS the test.
     *
     * How much an italic differs in width from its upright is a decision
     * the type designer made, not a property of italics. Inter's italic is
     * metrically close to its roman -- 0.05 em over a nineteen-character
     * string, a third of a point at 18pt, which rounds away in the
     * extraction. JetBrains Mono's is identical by definition, being
     * monospaced. A serif italic is a different alphabet, and Source Serif
     * 4's is 0.78 em narrower over the same string, which is a difference
     * this can actually see.
     *
     * Written against Inter first, where it passed whether or not the
     * writer measured the right face.
     */
    it('measures italic text at the italic face’s own advances', () => {
      const line = 'Widths of a serif italic'
      const serif = (y: number, italic: boolean): EditObject => ({
        id: `s${n++}`, pageId: 'p0', kind: 'text', text: line,
        rect: { x: 60, y, w: 400, h: 30 },
        rotation: 0, z: 1, locked: false, opacity: 1,
        fontFamily: 'Source Serif 4', italic, fontSize: 18,
        color: [0, 0, 0], align: 'center',
      } as EditObject)

      const out = replay(new Map([['src-0', bytes('simple-text')]]), docWith([
        serif(600, true),
        serif(560, false),
      ]), { fonts: FONTS })
      const blocks = JSON.parse(extract(out)).blocks as Array<{
        lines: Array<{ text: string; bbox: { x: number; w: number } }>
      }>
      const lines = blocks.flatMap((b) => b.lines).filter((l) => l.text.includes('Widths of'))
      expect(lines).toHaveLength(2)
      const [italicLine, uprightLine] = lines as [typeof lines[0], typeof lines[0]]

      // The italic really is narrower here, by enough to see.
      expect(uprightLine.bbox.w - italicLine.bbox.w).toBeGreaterThan(4)
      // And it is still centred on the box's centre, 260, at ITS OWN width.
      // Measuring the upright and drawing the italic would put it off by
      // half the difference above.
      expect(Math.abs(italicLine.bbox.x + italicLine.bbox.w / 2 - 260)).toBeLessThan(1.5)
    })
  })

  it('matches the reviewed golden', async () => {
    await assertGolden('export-text', replay(new Map([['src-0', bytes('simple-text')]]), docWith([
      textObject('Left aligned', 'left', 600),
      textObject('Centred', 'center', 550),
      textObject('Right aligned', 'right', 500),
      textObject('two\nlines', 'left', 400),
    ]), { fonts: FONTS }))
  })
})
