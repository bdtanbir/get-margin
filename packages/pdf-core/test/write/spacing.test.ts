import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replay } from '../../src/write/index.js'
import { hashText } from '../../src/write/objects/patch.js'
import {
  emptyEditDocument, type EditDocument, type EditObject, type TextObject, type TextPatchObject,
} from '../../src/write/types.js'
import { PdfDocument } from '../../src/index.js'
import { buildQuadIndex } from '../../src/text/index.js'
import { generateFixtures, fixturePath } from '../fixtures/index.js'

/**
 * Letter and line spacing, on custom text and on a replaced line.
 *
 * Every assertion is asked of the EXPORTED file's extraction, never of the
 * content stream's text: the operator could be present and wrong, and the
 * extraction is what a reader's viewer will also see.
 */
beforeAll(async () => { await generateFixtures() }, 60_000)
const src = (): Uint8Array => new Uint8Array(readFileSync(fixturePath('simple-text')))

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const fontFile = (f: string): Uint8Array =>
  new Uint8Array(readFileSync(join(ROOT, 'apps/web/public/fonts', f)))
const FONTS = new Map([['Inter', fontFile('Inter-400.ttf')]])

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

type Line = { text: string; bbox: [number, number, number, number] }
function linesOf(pdf: Uint8Array): Line[] {
  const d = PdfDocument.open(pdf)
  try {
    return buildQuadIndex(d, 0).lines.map((l) => ({ text: l.text, bbox: l.bbox }))
  } finally { d.close() }
}
/** Text with no whitespace at all, so a spaced line reads as its letters. */
const squash = (t: string): string => t.replace(/\s+/g, '')

/**
 * Matched with whitespace stripped from both sides: MuPDF's extraction
 * reads a gap wider than a fraction of the size as a word break, so a
 * line spaced 4pt comes back as "S p a c e d". That is the extractor
 * describing what it sees, and what it sees is the point.
 */
function lineWith(pdf: Uint8Array, needle: string): Line {
  const line = linesOf(pdf).find((l) => squash(l.text).includes(squash(needle)))
  if (!line) throw new Error(`no line containing "${needle}"`)
  return line
}
const widthOf = (pdf: Uint8Array, needle: string): number => {
  const b = lineWith(pdf, needle).bbox
  return b[2] - b[0]
}
const topOf = (pdf: Uint8Array, needle: string): number => lineWith(pdf, needle).bbox[1]

function text(over: Partial<TextObject> = {}): EditObject {
  return {
    id: 't1', pageId: 'p0', kind: 'text', text: 'Spaced out',
    // Clear of the fixture's own text, which sits in the top ~130pt.
    rect: { x: 60, y: 500, w: 400, h: 60 },
    rotation: 0, z: 1, locked: false, opacity: 1,
    fontFamily: 'Inter', fontSize: 18, color: [0, 0, 0], align: 'left',
    ...over,
  } as EditObject
}

describe('text writer: letter spacing', () => {
  it('draws the line wider by the spacing between each pair of characters', () => {
    const plain = write([text()])
    const spaced = write([text({ letterSpacing: 4 })])
    // "Spaced out" is 10 characters: 9 gaps of 4pt.
    expect(widthOf(spaced, 'Spaced') - widthOf(plain, 'Spaced')).toBeCloseTo(36, 0)
  })

  it('treats an absent spacing as none, which is what every stored object means', () => {
    expect(widthOf(write([text({ letterSpacing: 0 })]), 'Spaced'))
      .toBeCloseTo(widthOf(write([text()]), 'Spaced'), 1)
  })

  it('still ends a right-aligned line at the box edge', () => {
    const out = write([text({ letterSpacing: 6, align: 'right' })])
    const b = lineWith(out, 'Spaced').bbox
    // Box spans x 60..460.
    expect(Math.abs(b[2] - 460)).toBeLessThan(2)
  })

  it('still centres a line within the box', () => {
    const out = write([text({ letterSpacing: 6, align: 'center' })])
    const b = lineWith(out, 'Spaced').bbox
    expect(Math.abs((b[0] + b[2]) / 2 - 260)).toBeLessThan(3)
  })
})

describe('text writer: line spacing', () => {
  // Spread rather than passed through: under `exactOptionalPropertyTypes`
  // a key holding `undefined` is not an absent key, and absent is what a
  // stored object without a line height is.
  const two = (lineHeight?: number) =>
    write([text({ text: 'first\nsecond', ...(lineHeight === undefined ? {} : { lineHeight }) })])
  const pitch = (pdf: Uint8Array): number => topOf(pdf, 'second') - topOf(pdf, 'first')

  it('stacks lines at the stored multiple of the font size', () => {
    // 18pt at 2.0 is 36pt apart; at the default 1.2 it is 21.6.
    expect(pitch(two(2))).toBeCloseTo(36, 0)
  })

  it('keeps the default pitch when no line height is stored', () => {
    expect(pitch(two())).toBeCloseTo(18 * 1.2, 0)
  })

  it('leaves the first line where it was, whatever the pitch', () => {
    expect(topOf(two(2), 'first')).toBeCloseTo(topOf(two(), 'first'), 1)
  })
})

describe('text patch: letter spacing', () => {
  function patch(over: Partial<TextPatchObject> = {}): EditObject {
    const original = linesOf(src())[0]!.text
    return {
      id: 'p1', pageId: 'p0', kind: 'textPatch',
      lineIndex: 0,
      originalHash: hashText(original),
      originalText: original,
      text: 'Replaced',
      fontFamily: 'Inter', fontSize: 0, color: [0, 0, 0],
      background: [1, 1, 1], backgroundConfidence: 1,
      fit: 'overflow',
      rect: { x: 0, y: 0, w: 0, h: 0 },
      rotation: 0, z: 1, locked: false, opacity: 1,
      ...over,
    } as EditObject
  }

  it('draws the replacement wider by the spacing between each pair of characters', () => {
    const plain = write([patch()])
    const spaced = write([patch({ letterSpacing: 3 })])
    // "Replaced" is 8 characters: 7 gaps of 3pt.
    expect(widthOf(spaced, 'Replaced') - widthOf(plain, 'Replaced')).toBeCloseTo(21, 0)
  })

  it('measures the spacing when deciding whether it fits', () => {
    // 'truncate' cuts until the line fits. Spaced text must lose more
    // characters -- which it only does if the fit loop counted the gaps.
    const long = 'A replacement long enough that it will not fit'
    const tight = write([patch({ text: long, fit: 'truncate' })])
    const loose = write([patch({ text: long, fit: 'truncate', letterSpacing: 4 })])
    expect(squash(lineWith(loose, 'A rep').text).length)
      .toBeLessThan(squash(lineWith(tight, 'A rep').text).length)
  })

  it('shrinks a spaced replacement until it fits, keeping all of it', () => {
    const long = 'A replacement long enough that it will not fit'
    const out = write([patch({ text: long, fit: 'shrink', letterSpacing: 2 })])
    const line = lineWith(out, 'A rep')
    expect(squash(line.text)).toContain('notfit')
    // Fits the line it replaces: the fixture's first line ends well before
    // the page's right edge.
    expect(line.bbox[2]).toBeLessThan(612)
  })
})
