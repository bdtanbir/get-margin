import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { replay } from '../../src/write/index.js'
import { hashText } from '../../src/write/objects/patch.js'
import { layoutRuns, blockLayout, type PatchRun } from '../../src/write/patchRuns.js'
import { emptyEditDocument, type EditObject, type TextPatchObject } from '../../src/write/types.js'
import { PdfDocument } from '../../src/index.js'
import { buildQuadIndex } from '../../src/text/index.js'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const FONTS = new Map([
  ['Inter', new Uint8Array(readFileSync(join(ROOT, 'apps/web/public/fonts', 'Inter-400.ttf')))],
])

/** A page with one three-line paragraph at 12pt, 16pt apart, and a footer far below. */
async function paragraphPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([612, 792])
  page.drawText('Careers in health and social care may follow', { x: 72, y: 700, size: 12, font })
  page.drawText('many different paths depending on the role and', { x: 72, y: 684, size: 12, font })
  page.drawText('experience and opportunities.', { x: 72, y: 668, size: 12, font })
  page.drawText('Footer line', { x: 72, y: 200, size: 12, font })
  return doc.save()
}

function index(pdf: Uint8Array) {
  const d = PdfDocument.open(pdf)
  try { return buildQuadIndex(d, 0) } finally { d.close() }
}

function paragraphPatch(lines: string[], text: string): TextPatchObject {
  return {
    id: 'p1', pageId: 'p0', kind: 'textPatch',
    lineIndex: 0,
    originalHash: hashText(lines[0]!),
    originalText: lines[0]!,
    text,
    fontFamily: 'Inter', fontSize: 12, color: [0, 0, 0],
    background: [1, 1, 1], backgroundConfidence: 1,
    fit: 'overflow',
    rect: { x: 0, y: 0, w: 0, h: 0 },
    rotation: 0, z: 1, locked: false, opacity: 1,
    paragraph: {
      lines: lines.slice(1).map((t, i) => ({ lineIndex: i + 1, originalHash: hashText(t), originalText: t })),
      width: 260,
      leading: 16 / 12,
      indent: 0,
    },
  }
}

function write(pdf: Uint8Array, objects: EditObject[]): Uint8Array {
  return replay(new Map([['src-0', pdf]]), {
    ...emptyEditDocument(),
    sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: ['p0'],
    pages: { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
  }, { fonts: FONTS })
}

describe('extraction blocks', () => {
  it('records which block each line came from', async () => {
    const lines = index(await paragraphPdf()).lines
    expect(lines.every((l) => typeof l.block === 'number')).toBe(true)
  })
})

describe('a paragraph patch', () => {
  it('removes every line of the paragraph and draws the new text wrapped', async () => {
    const pdf = await paragraphPdf()
    const before = index(pdf).lines.map((l) => l.text)
    const long = 'experience and opportunities for progression. '.repeat(4).trim()
    const out = write(pdf, [paragraphPatch(before.slice(0, 3), long) as EditObject])
    const after = index(out).lines
    const text = after.map((l) => l.text).join(' ')

    // The old words are gone.
    expect(text).not.toContain('Careers in health')
    expect(text).not.toContain('many different paths')
    // The new text is there, broken into several lines, none wider than the wrap.
    const drawn = after.filter((l) => l.text.includes('progression') || l.text.includes('experience'))
    expect(drawn.length).toBeGreaterThan(1)
    for (const l of drawn) expect(l.bbox[2] - 72).toBeLessThanOrEqual(262)
    // Stacked down the page at the leading, starting on the first line's baseline.
    const baselines = drawn.map((l) => l.baseline).sort((a, b) => a - b)
    expect(baselines[0]).toBeCloseTo(792 - 700, 0)
    expect(baselines[1]! - baselines[0]!).toBeCloseTo(16, 0)
    // Nothing else moved.
    expect(text).toContain('Footer line')
  })

  it('breaks at a typed line break', async () => {
    const pdf = await paragraphPdf()
    const before = index(pdf).lines.map((l) => l.text)
    const out = write(pdf, [paragraphPatch(before.slice(0, 3), 'First\nSecond') as EditObject])
    const texts = index(out).lines.map((l) => l.text)
    expect(texts).toContain('First')
    expect(texts).toContain('Second')
  })

  it('refuses when a later line of the paragraph has changed', async () => {
    const pdf = await paragraphPdf()
    const before = index(pdf).lines.map((l) => l.text)
    const p = paragraphPatch(before.slice(0, 3), 'x')
    p.paragraph!.lines[1]!.originalHash = hashText('something else')
    expect(() => write(pdf, [p as EditObject])).toThrow(/changed/)
  })
})

describe('layoutRuns', () => {
  const run = (text: string): PatchRun => ({ text, weight: 400, italic: false, scale: 1, rise: 0, color: [0, 0, 0] })
  // Every character 1pt wide at size 1.
  const measure = (r: PatchRun, size: number): number => [...r.text].length * size
  const lay = (text: string, width: number, indent = 0) =>
    layoutRuns([run(text)], { width, indent, size: 1, spacing: 0, measure })
      .map((l) => l.map((r) => r.text).join(''))

  it('wraps at word boundaries and swallows the space at the break', () => {
    expect(lay('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc'])
  })
  it('honours a hard break and keeps an empty line', () => {
    expect(lay('aa\n\nbb', 10)).toEqual(['aa', '', 'bb'])
  })
  it('gives the first line less room when it is indented', () => {
    expect(lay('aaa bbb ccc', 7, 2)).toEqual(['aaa', 'bbb ccc'])
  })
  it('breaks a word longer than the line between characters', () => {
    expect(lay('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  })
  it('does not wrap with no width', () => {
    expect(lay('aaa bbb\nccc', 0)).toEqual(['aaa bbb', 'ccc'])
  })
  it('keeps each word in its own style across a wrap', () => {
    const bold = { ...run('Bold: '), weight: 700 }
    const lines = layoutRuns([bold, run('rest of it')], { width: 10, indent: 0, size: 1, spacing: 0, measure })
    expect(lines[0]![0]).toMatchObject({ text: 'Bold: ', weight: 700 })
    expect(lines[0]![1]).toMatchObject({ text: 'rest', weight: 400 })
    expect(lines[1]).toEqual([run('of it')])
  })
})

describe('blockLayout', () => {
  it('is undefined for a plain one-line patch', () => {
    expect(blockLayout({ text: 'one line' })).toBeUndefined()
  })
  it('makes a line with a break into a block with default leading', () => {
    expect(blockLayout({ text: 'a\nb' })).toEqual({ width: 0, leading: 1.2, indent: 0 })
  })
})
