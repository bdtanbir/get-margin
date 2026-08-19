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
const FONTS = new Map([[
  'Inter', new Uint8Array(readFileSync(join(ROOT, 'apps/web/public/fonts/Inter.ttf'))),
]])
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

  it('uses an explicit size over the derived one', () => {
    const small = write([patch({ text: 'Sized', fontSize: 6 })])
    const large = write([patch({ text: 'Sized', fontSize: 24 })])
    expect(large.length).not.toBe(small.length)
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
