import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { replay } from '../../src/write/index.js'
import { hashText, missingGlyphs, PatchRefused } from '../../src/write/objects/patch.js'
import {
  emptyEditDocument, type EditDocument, type EditObject, type TextPatchObject,
} from '../../src/write/types.js'
import { generateFixtures, fixturePath } from '../fixtures/index.js'
import { PdfDocument } from '../../src/index.js'
import { buildQuadIndex } from '../../src/text/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const fontFile = (f: string): Uint8Array =>
  new Uint8Array(readFileSync(join(ROOT, 'apps/web/public/fonts', f)))
const FONTS = new Map([
  ['Inter', fontFile('Inter.ttf')],
  ['Inter Bold', fontFile('Inter-Bold.ttf')],
  ['Inter Italic', fontFile('Inter-Italic.ttf')],
  ['Inter Bold Italic', fontFile('Inter-BoldItalic.ttf')],
])
const src = (): Uint8Array => new Uint8Array(readFileSync(fixturePath('simple-text')))

/** A character no Latin subset carries, spelled as an escape. */
const CJK = '漢'

/** The lines of a document, as the writer will re-extract them. */
function linesOf(pdf: Uint8Array, page = 0): string[] {
  const d = PdfDocument.open(pdf)
  try {
    return buildQuadIndex(d, page).lines.map((l) => l.chars.map((c) => c.char).join(''))
  } finally { d.close() }
}

function patch(over: Partial<TextPatchObject> = {}): TextPatchObject {
  const original = linesOf(src())[0]!
  return {
    id: 'p1', pageId: 'p0', kind: 'textPatch',
    lineIndex: 0,
    originalHash: hashText(original),
    originalText: original,
    text: 'Replacement text',
    fontFamily: 'Inter', fontSize: 0, color: [0, 0, 0],
    background: [1, 1, 1], backgroundConfidence: 1,
    fit: 'shrink',
    rect: { x: 0, y: 0, w: 0, h: 0 },
    rotation: 0, z: 1, locked: false, opacity: 1,
    ...over,
  }
}

function doc(objects: EditObject[]): EditDocument {
  return {
    ...emptyEditDocument(),
    sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: ['p0'],
    pages: { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
  }
}

const write = (objects: EditObject[]): Uint8Array =>
  replay(new Map([['src-0', src()]]), doc(objects), { fonts: FONTS })

/**
 * Whether the exported line containing `needle` is drawn bold, asked of
 * MuPDF rather than of the object that produced it -- the same call the app
 * uses to inherit weight from a document it did not write.
 */
function boldnessOf(pdf: Uint8Array, needle: string): boolean | undefined {
  const d = PdfDocument.open(pdf)
  try {
    return buildQuadIndex(d, 0).lines.find((l) => l.text.includes(needle))?.bold
  } finally { d.close() }
}

/** The full text of the exported line containing `needle`. */
function textOf(pdf: Uint8Array, needle: string): string {
  const d = PdfDocument.open(pdf)
  try {
    const line = buildQuadIndex(d, 0).lines.find((l) => l.text.includes(needle))
    if (!line) throw new Error(`no line containing "${needle}"`)
    return line.text
  } finally { d.close() }
}

/** The rendered width of the line containing `needle`, in page units. */
function widthOf(pdf: Uint8Array, needle: string): number {
  const d = PdfDocument.open(pdf)
  try {
    const line = buildQuadIndex(d, 0).lines.find((l) => l.text.includes(needle))
    if (!line) throw new Error(`no line containing "${needle}"`)
    return line.bbox[2] - line.bbox[0]
  } finally { d.close() }
}

describe('hashText', () => {
  it('is stable for the same text', () => {
    expect(hashText('Hello margin')).toBe(hashText('Hello margin'))
  })

  it('differs for different text', () => {
    expect(hashText('Hello margin')).not.toBe(hashText('Hello Margin'))
    expect(hashText('a')).not.toBe(hashText('b'))
  })

  it('handles empty text', () => {
    expect(hashText('')).toHaveLength(8)
  })
})

describe('text patching', () => {
  it('draws the replacement onto the page', () => {
    const out = write([patch({ text: 'Replacement text' })])
    expect(linesOf(out).join(' ')).toContain('Replacement text')
  })

  /**
   * Cover-and-redraw, not removal -- the original glyphs are still in the
   * content stream, hidden under an opaque rectangle. That is a real
   * limitation and belongs in a test rather than a footnote: someone who
   * needs the old text GONE wants redaction, not patching.
   */
  it('covers rather than removes, which is why redaction exists separately', () => {
    const out = write([patch({ text: 'Replacement text' })])
    // The original is STILL EXTRACTABLE: it is hidden under an opaque
    // rectangle, not deleted. Asserted through extraction rather than a
    // byte search, because content streams are compressed and a raw search
    // would report "absent" for text that is plainly there.
    expect(linesOf(out).join(' ')).toContain('Hello margin')
  })

  it('leaves other lines alone', () => {
    const before = linesOf(src())
    const out = write([patch({ text: 'Replacement text' })])
    expect(linesOf(out).some((l) => l.includes(before[1] ?? ' '))).toBe(true)
  })

  it('can blank a line entirely', () => {
    const out = write([patch({ text: '' })])
    expect(linesOf(out).join(' ')).not.toContain('Replacement')
  })
})

/**
 * THE GUARD, and the reason this feature is safe to ship at all. Quietly
 * patching the wrong line damages a document while reporting success,
 * which is the worst outcome available.
 */
describe('the hash guard', () => {
  /**
   * replay wraps a writer's error to name the object and page, so the
   * PatchRefused arrives as the `cause`. Asserting on the cause rather
   * than the top-level class is what keeps this testing the guard instead
   * of testing replay's error formatting.
   */
  it('refuses when the line no longer says what it did', () => {
    let caught: unknown
    try {
      write([patch({ originalHash: hashText('something else') })])
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).cause).toBeInstanceOf(PatchRefused)
  })

  it('names both the old text and what is there now', () => {
    expect(() => write([patch({
      originalHash: hashText('something else'),
      originalText: 'something else',
    })])).toThrow(/said "something else" and now reads "Hello margin"/)
  })

  it('refuses when the line is gone entirely', () => {
    expect(() => write([patch({ lineIndex: 99 })])).toThrow(/no longer on the page/)
  })

  it('fails the WHOLE export rather than skipping the patch', () => {
    // A partial export that silently dropped an edit is worse than a
    // failed one: the user does not notice the omission.
    expect(() => write([
      patch({ id: 'good' }),
      patch({ id: 'bad', originalHash: 'deadbeef' }),
    ])).toThrow(/has changed since it was edited/)
  })

  it('names the page, through replay own error wrapping', () => {
    expect(() => write([patch({ originalHash: 'deadbeef' })]))
      .toThrow(/textPatch on page 1/)
  })
})

describe('fitting', () => {
  const long = 'This replacement is considerably longer than the line it replaces, by design'

  /**
   * How much of `long` survived into the exported page.
   *
   * Anchored on the first WORD, not a phrase: truncate cuts to whatever
   * fits the line, and on a line as short as "Hello margin" that can be
   * fewer characters than a multi-word anchor -- which made the first
   * version of this helper return nothing and the test fail for the wrong
   * reason. The original line contains no "This", so the anchor is
   * unambiguous.
   */
  const drawn = (fit: TextPatchObject['fit']): string => {
    const text = linesOf(write([patch({ text: long, fit })])).join(' ')
    const at = text.indexOf('This')
    return at === -1 ? '' : text.slice(at)
  }

  it('shrinks text to fit the line width, keeping all of it', () => {
    // The whole string is present, at a smaller size.
    expect(drawn('shrink')).toContain('by design')
  })

  /**
   * Truncate cuts the string until it fits, so what lands is a strict
   * PREFIX. On a short line that prefix is short -- which is the feature,
   * not a bug, and the assertion says so rather than assuming a length.
   */
  it('truncates to a prefix that fits', () => {
    const cut = drawn('truncate')
    expect(cut.length).toBeGreaterThan(0)
    expect(long.startsWith(cut.trim().slice(0, 4))).toBe(true)
    expect(cut).not.toContain('by design')
  })

  it('cuts less than shrink keeps', () => {
    expect(drawn('truncate').length).toBeLessThan(drawn('shrink').length)
  })

  /**
   * Overflow is deliberate: the user chose to let it run, and surrounding
   * content is never pushed around (PLAN.md 2.4). At full size on a short
   * line it runs past the page edge, so more of it is DRAWN than truncate
   * keeps even though not all of it is extractable.
   */
  it('lets it run rather than cutting it', () => {
    expect(drawn('overflow').length).toBeGreaterThan(drawn('truncate').length)
  })

  /**
   * Measured as rendered ink, not as byte length.
   *
   * This used to compare the two outputs' sizes in bytes, which passed only
   * because the derived baseline changed with the font size and produced
   * differently-long decimals. Sitting the text on the line's real baseline
   * made that number identical for both, and the test failed while the
   * feature worked -- it had been asserting a coincidence.
   */
  it('uses an explicit size over the derived one', () => {
    const inkHeight = (fontSize: number): number => {
      const out = write([patch({ text: 'Sized', fontSize, fit: 'overflow' })])
      const doc = mupdf.Document.openDocument(Buffer.from(out), 'application/pdf')
      const pm = doc
        .loadPage(0)
        .toPixmap(mupdf.Matrix.scale(4, 4), mupdf.ColorSpace.DeviceRGB, false, true)
      const w = pm.getWidth()
      const h = pm.getHeight()
      const px = Uint8Array.from(pm.getPixels())
      let top = Infinity
      let bottom = -Infinity
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (px[(y * w + x) * 3]! < 128) {
            top = Math.min(top, y)
            bottom = Math.max(bottom, y)
          }
        }
      }
      return bottom - top
    }

    expect(inkHeight(24)).toBeGreaterThan(inkHeight(6))
  })
})

/**
 * Embedded fonts in real PDFs are almost always SUBSETS carrying only the
 * glyphs already used, so a character the subset lacks has no glyph to
 * draw. MuPDF returns glyph 0 -- the .notdef box -- rather than failing,
 * which is how a patch silently becomes a row of empty rectangles.
 */
describe('missingGlyphs', () => {
  const inter = (): mupdf.Font => new mupdf.Font('Inter', FONTS.get('Inter')!)

  it('reports nothing for text the font can draw', () => {
    expect(missingGlyphs(inter(), 'Hello margin')).toEqual([])
  })

  it('ignores spaces, which need no glyph', () => {
    expect(missingGlyphs(inter(), '   ')).toEqual([])
  })

  it('reports a character the font has no glyph for', () => {
    expect(missingGlyphs(inter(), `Hello ${CJK}`).length).toBeGreaterThan(0)
  })

  it('reports each missing character once', () => {
    expect(missingGlyphs(inter(), CJK + CJK + CJK)).toHaveLength(1)
  })
})

/**
 * Weight on a replacement for the DOCUMENT's own text.
 *
 * The reported bug: editing a line that was set bold gave back regular. The
 * writer half of the fix is here -- the patch has to reach for the bold FACE
 * -- and the inheriting half is in the app, which seeds `bold` from
 * `LineRun.bold`. Both halves are needed and neither is sufficient.
 */
describe('text patch weight', () => {
  it('draws the replacement in the bold face when the patch says so', () => {
    const out = write([patch({ text: 'Bold replacement', bold: true }) as EditObject])
    expect(boldnessOf(out, 'Bold replacement')).toBe(true)
  })

  it('draws it regular when the patch does not', () => {
    const out = write([patch({ text: 'Plain replacement' }) as EditObject])
    expect(boldnessOf(out, 'Plain replacement')).toBe(false)
  })

  it('refuses rather than quietly substituting the regular', () => {
    // The same discipline the text writer keeps. A patch that came out at
    // the wrong weight would look like a formatting bug in the user's
    // source document rather than a missing file in ours.
    expect(() => replay(new Map([['src-0', src()]]), doc([
      patch({ text: 'Bold replacement', bold: true }) as EditObject,
    ]), { fonts: new Map([['Inter', fontFile('Inter.ttf')]]) })).toThrow(/Inter Bold/)
  })

  it('draws bold wider than regular for the same string', () => {
    // The ink itself. Bold outlines are wider, so a patch that ran through
    // the bold file must occupy more of the line than the same string set
    // regular. 'overflow' so nothing rescales it on the way.
    const same = 'Identical replacement string'
    const regular = write([patch({ id: 'r', text: same, fit: 'overflow' }) as EditObject])
    const bold = write([patch({ id: 'b', text: same, fit: 'overflow', bold: true }) as EditObject])
    expect(widthOf(bold, 'Identical')).toBeGreaterThan(widthOf(regular, 'Identical'))
  })

  it('truncates bold sooner, because it measured the bold advances', () => {
    // The MEASUREMENT path, isolated. 'truncate' drops characters until the
    // line fits, so a wider face must lose more of them. If the fit loop
    // measured the regular while the writer drew the bold, this comes back
    // equal -- text drawn past the edge of the box it was told to stay in.
    //
    // Line 1 rather than line 0 on purpose: bold is only a few percent
    // wider, so the cut point moves by a fraction of a character. The
    // fixture's second line is long and set small, which is enough
    // characters for that fraction to be a whole one.
    const long = 'A replacement long enough that it will certainly not fit on this line at all'
    const on1 = (over: Partial<TextPatchObject>): EditObject => {
      const original = linesOf(src())[1]!
      return patch({
        lineIndex: 1,
        originalHash: hashText(original),
        originalText: original,
        fit: 'truncate',
        text: long,
        ...over,
      }) as EditObject
    }
    const regular = write([on1({ id: 'r' })])
    const bold = write([on1({ id: 'b', bold: true })])
    expect(textOf(bold, 'A rep').length).toBeLessThan(textOf(regular, 'A rep').length)
  })
})

/**
 * Size on a replacement for the DOCUMENT's own text.
 *
 * The writer already honoured `fontSize`; what was missing was anything
 * that could set it, and a guarantee that setting it does not move the text
 * off the line it is replacing. These pin the second half: a resized
 * replacement changes height and NOT baseline, because the writer sits it
 * on the pen position it re-extracts rather than on one derived from the
 * box and the size.
 */
describe('text patch size', () => {
  /** The height of the exported line containing `needle`, in page units. */
  const heightOf = (pdf: Uint8Array, needle: string): number => {
    const d = PdfDocument.open(pdf)
    try {
      const line = buildQuadIndex(d, 0).lines.find((l) => l.text.includes(needle))
      if (!line) throw new Error(`no line containing "${needle}"`)
      return line.bbox[3] - line.bbox[1]
    } finally { d.close() }
  }

  const baselineOf = (pdf: Uint8Array, needle: string): number => {
    const d = PdfDocument.open(pdf)
    try {
      const line = buildQuadIndex(d, 0).lines.find((l) => l.text.includes(needle))
      if (!line) throw new Error(`no line containing "${needle}"`)
      return line.baseline
    } finally { d.close() }
  }

  const sizeOf = (pdf: Uint8Array, needle: string): number => {
    const d = PdfDocument.open(pdf)
    try {
      const line = buildQuadIndex(d, 0).lines.find((l) => l.text.includes(needle))
      if (!line) throw new Error(`no line containing "${needle}"`)
      return line.size
    } finally { d.close() }
  }

  it('sets the replacement in the size the patch asks for', () => {
    const out = write([patch({ text: 'Resized', fontSize: 30, fit: 'overflow' }) as EditObject])
    expect(sizeOf(out, 'Resized')).toBeCloseTo(30, 1)
  })

  it('still matches the original line when the size is left at 0', () => {
    // The sentinel every patch written before the size was editable holds.
    // The fixture's first line is set in 24pt.
    const out = write([patch({ text: 'Inherited', fontSize: 0, fit: 'overflow' }) as EditObject])
    expect(sizeOf(out, 'Inherited')).toBeCloseTo(24, 1)
  })

  it('grows the text without moving the line it sits on', () => {
    // The whole reason the writer reads the pen position rather than
    // deriving one: a bigger replacement has to grow UPWARD from the
    // baseline it shares with the text around it, not slide down the page.
    const small = write([patch({ id: 's', text: 'Sized', fontSize: 12, fit: 'overflow' }) as EditObject])
    const large = write([patch({ id: 'l', text: 'Sized', fontSize: 30, fit: 'overflow' }) as EditObject])
    expect(heightOf(large, 'Sized')).toBeGreaterThan(heightOf(small, 'Sized') * 2)
    expect(baselineOf(large, 'Sized')).toBeCloseTo(baselineOf(small, 'Sized'), 1)
  })

  it('measures the chosen size when deciding whether it fits', () => {
    // 'truncate' cuts until the line fits. A larger size must lose more
    // characters -- which it only does if the fit loop measured at the size
    // the text is actually drawn in.
    const long = 'A replacement long enough that it will not fit'
    const small = write([patch({ id: 's', text: long, fontSize: 10, fit: 'truncate' }) as EditObject])
    const large = write([patch({ id: 'l', text: long, fontSize: 20, fit: 'truncate' }) as EditObject])
    expect(textOf(large, 'A rep').length).toBeLessThan(textOf(small, 'A rep').length)
  })
})

/**
 * A patch that changes ONLY the style, leaving the text alone.
 *
 * What the selection toolbar's Bold and Italic buttons produce, and what
 * pressing Ctrl+B in the inline editor produces: `text` identical to
 * `originalText`, with one style flag flipped. Worth its own test because
 * every other patch test here changes the text, so none of them would
 * notice the writer taking a shortcut for a replacement that reads the
 * same as the original.
 */
describe('a style-only patch', () => {
  /**
   * Every extracted line reading `needle`, with its style.
   *
   * Plural because a patch COVERS rather than removes: the document's own
   * glyphs are still under the cover, so a patched line comes back twice.
   * Taking `.find()` here would have returned the covered original and
   * reported the patch had done nothing.
   */
  const drawnStyles = (pdf: Uint8Array, needle: string) => {
    const d = PdfDocument.open(pdf)
    try {
      return buildQuadIndex(d, 0).lines
        .filter((l) => l.text.includes(needle))
        .map((l) => ({ bold: l.bold, italic: l.italic, text: l.text }))
    } finally { d.close() }
  }

  const original = (): string => linesOf(src())[0]!

  it('redraws the same words in the new face', () => {
    const out = write([patch({
      text: original(), bold: true, italic: true, fit: 'overflow',
    }) as EditObject])
    const drawn = drawnStyles(out, 'Hello margin')
    // The covered original, upright and regular, and the redraw over it.
    expect(drawn).toContainEqual({ text: original(), bold: false, italic: false })
    expect(drawn).toContainEqual({ text: original(), bold: true, italic: true })
  })

  it('still passes the hash guard, because the ORIGINAL is what is hashed', () => {
    // The guard compares the document's line against `originalHash`. A
    // style-only patch leaves both alone, so this is really a check that
    // nothing in the style path recomputes the hash from the replacement.
    expect(() => write([patch({ text: original(), bold: true }) as EditObject])).not.toThrow()
  })

  /**
   * COVERS the original. Does not remove it.
   *
   * The upright glyphs are still in the content stream under the cover, so
   * a style-only patch makes the line extractable TWICE -- once as the
   * document set it, once as the patch redrew it. That is the same property
   * `whiteout.test.ts` asserts, and it is the reason redaction is a
   * separate tool: styling text is not a way to hide it.
   *
   * Written expecting one line and corrected to two, which is how the
   * distinction earned a test of its own here rather than a comment.
   */
  it('leaves the original extractable, because covering is not removing', () => {
    const out = write([patch({ text: original(), bold: true, fit: 'overflow' }) as EditObject])
    expect(linesOf(out).filter((l) => l.includes('Hello margin'))).toHaveLength(2)
  })
})
