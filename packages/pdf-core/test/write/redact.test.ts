import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import * as mupdf from 'mupdf'
import type { EditObject } from '../../src/write/types.js'
import { generateFixtures } from '../fixtures/index.js'
import { bytes, textOf, redactionFor, write } from './redactHelpers.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: FixtureName): Uint8Array => new Uint8Array(readFileSync(fixturePath(n)))

describe('redaction', () => {
  it('removes the text from the page', () => {
    const out = write([redactionFor('simple-text', 0, 'p0', 'Hello')])
    expect(textOf(out)).not.toContain('Hello')
  })

  /**
   * Deleting the drawing operation is not enough -- the glyphs would still
   * be in the content stream for anyone reading the bytes. This is the
   * difference between redaction and whiteout, stated as an assertion.
   */
  it('removes it from the exported bytes, not just the text layer', () => {
    const out = write([redactionFor('simple-text', 0, 'p0', 'Hello')])
    expect(Buffer.from(out).includes('Hello')).toBe(false)
  })

  /**
   * THE RISK THIS FEATURE HAS TO GET RIGHT. A redaction that swallowed the
   * rest of its text run would be data loss dressed as safety.
   */
  it('takes the word and not its neighbours', () => {
    const out = write([redactionFor('simple-text', 0, 'p0', 'body')])
    const after = textOf(out)
    expect(after).not.toContain('body')
    expect(after).toContain('Second')
    expect(after).toContain('extraction')
  })

  it('removes part of a word and leaves the rest', () => {
    const out = write([redactionFor('simple-text', 0, 'p0', 'extra')])
    const after = textOf(out)
    expect(after).not.toContain('extra')
    expect(after).toContain('ction')
  })

  it('removes several redactions on one page', () => {
    const out = write([
      redactionFor('simple-text', 0, 'p0', 'Hello'),
      redactionFor('simple-text', 0, 'p0', 'body'),
    ])
    const after = textOf(out)
    expect(after).not.toContain('Hello')
    expect(after).not.toContain('body')
    expect(after).toContain('Second')
  })

  it('works on every page rotation', () => {
    const out = write(
      [0, 1, 2, 3].map((i) => ({
        ...redactionFor('rotated', i, `p${i}`, 'rotate'), id: `r${i}`,
      })),
      'rotated', 4,
    )
    for (const i of [0, 1, 2, 3]) {
      expect(textOf(out, i), `page ${i}`).not.toContain('rotate')
    }
    expect(Buffer.from(out).includes('rotate')).toBe(false)
  })

  it('leaves a page with no redaction alone', () => {
    const before = textOf(bytes('rotated'), 1)
    const out = write([redactionFor('rotated', 0, 'p0', 'rotate')], 'rotated', 2)
    expect(textOf(out, 1)).toBe(before)
  })

  /**
   * blackBox decides whether a MARK is drawn, not whether the text is
   * removed -- the pre-flight verified removal with it false. Both are
   * asserted so neither can quietly start depending on the other.
   */
  it('removes the text whether or not a box is drawn', () => {
    expect(textOf(write([redactionFor('simple-text', 0, 'p0', 'Hello', false)])))
      .not.toContain('Hello')
    expect(textOf(write([redactionFor('simple-text', 0, 'p0', 'Hello', true)])))
      .not.toContain('Hello')
  })

  it('draws something when a box is asked for, and less when it is not', () => {
    const withBox = write([redactionFor('simple-text', 0, 'p0', 'Hello', true)])
    const without = write([redactionFor('simple-text', 0, 'p0', 'Hello', false)])
    expect(withBox.length).toBeGreaterThan(without.length)
  })

  it('is not an annotation in the exported file', () => {
    const out = write([redactionFor('simple-text', 0, 'p0', 'Hello')])
    const doc = mupdf.PDFDocument.openDocument(out, 'application/pdf') as mupdf.PDFDocument
    const p = doc.loadPage(0)
    try {
      // The Redact annotation is consumed by applyRedactions; a leftover
      // one would tell a reader exactly what was hidden and where.
      expect(p.getAnnotations()).toHaveLength(0)
    } finally { p.destroy(); doc.destroy() }
  })

  it('defeats the byte-identical pass-through', () => {
    const src = bytes('simple-text')
    const out = write([redactionFor('simple-text', 0, 'p0', 'Hello')])
    expect(Buffer.from(out).equals(Buffer.from(src))).toBe(false)
  })
})

/**
 * The distinction the product depends on, asserted side by side so it
 * cannot blur. Phase 2's whiteout copy says the text underneath is still
 * extractable; this is the other half of that promise.
 */
describe('redaction versus whiteout', () => {
  const whiteout = (): EditObject => ({
    id: 'w1', pageId: 'p0', kind: 'whiteout',
    rect: { x: 50, y: 700, w: 200, h: 40 },
    rotation: 0, z: 1, locked: false, opacity: 1, fill: [1, 1, 1],
  })

  it('whiteout leaves the text extractable', () => {
    expect(textOf(write([whiteout()]))).toContain('Hello')
  })

  it('redaction does not', () => {
    expect(textOf(write([redactionFor('simple-text', 0, 'p0', 'Hello')]))).not.toContain('Hello')
  })
})
