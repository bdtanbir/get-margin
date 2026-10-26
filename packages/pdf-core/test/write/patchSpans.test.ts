import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replay } from '../../src/write/index.js'
import { hashText } from '../../src/write/objects/patch.js'
import { patchRuns, truncateRuns } from '../../src/write/patchRuns.js'
import {
  emptyEditDocument, type EditDocument, type EditObject, type TextPatchObject,
} from '../../src/write/types.js'
import { generateFixtures, fixturePath } from '../fixtures/index.js'
import { PdfDocument } from '../../src/index.js'
import { buildQuadIndex, type LineRun } from '../../src/text/index.js'

/**
 * A text patch in more than one style: "This letter is to confirm that
 * **Arafat Hussain Chowdhury**...", where editing any word used to redraw
 * the whole line in the first word's face and un-bold the name.
 */

beforeAll(async () => { await generateFixtures() }, 60_000)

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const fontFile = (f: string): Uint8Array =>
  new Uint8Array(readFileSync(join(ROOT, 'apps/web/public/fonts', f)))
const FONTS = new Map([
  ['Inter', fontFile('Inter-400.ttf')],
  ['Inter 700', fontFile('Inter-700.ttf')],
  ['Inter Italic', fontFile('Inter-400Italic.ttf')],
])
const src = (): Uint8Array => new Uint8Array(readFileSync(fixturePath('simple-text')))

function lines(pdf: Uint8Array): LineRun[] {
  const d = PdfDocument.open(pdf)
  try { return buildQuadIndex(d, 0).lines } finally { d.close() }
}

function patch(over: Partial<TextPatchObject>): TextPatchObject {
  const original = lines(src())[0]!.text
  return {
    id: 'p1', pageId: 'p0', kind: 'textPatch',
    lineIndex: 0,
    originalHash: hashText(original),
    originalText: original,
    text: '',
    fontFamily: 'Inter', fontSize: 12, color: [0, 0, 0],
    background: [1, 1, 1], backgroundConfidence: 1,
    fit: 'overflow',
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

const lineWith = (pdf: Uint8Array, needle: string): LineRun => {
  const found = lines(pdf).find((l) => l.text.includes(needle))
  if (!found) throw new Error(`no line containing "${needle}"`)
  return found
}

describe('a text patch with styled spans', () => {
  it('exports each span in its own weight', () => {
    const pdf = write([patch({
      text: 'Confirm that Arafat Hussain is here',
      spans: [
        { text: 'Confirm that ' },
        { text: 'Arafat Hussain', weight: 700 },
        { text: ' is here' },
      ],
    })])
    const line = lineWith(pdf, 'Arafat Hussain')
    expect(line.text.trim()).toBe('Confirm that Arafat Hussain is here')
    const bold = line.spans!.filter((s) => s.weight === 700).map((s) => s.text).join('')
    const regular = line.spans!.filter((s) => s.weight === 400).map((s) => s.text).join('')
    expect(bold).toContain('Arafat Hussain')
    expect(regular).toContain('Confirm that')
    expect(regular).toContain('is here')
  })

  it('exports a raised, smaller span as a superscript', () => {
    const pdf = write([patch({
      text: 'Between 14th November',
      spans: [
        { text: 'Between 14' },
        { text: 'th', scale: 0.67, rise: 0.33 },
        { text: ' November' },
      ],
    })])
    const line = lineWith(pdf, 'November')
    const th = line.spans!.find((s) => s.text === 'th')
    expect(th).toBeDefined()
    expect(th!.size).toBeCloseTo(12 * 0.67, 1)
    expect(th!.rise).toBeCloseTo(12 * 0.33, 0)
    // The text after it is back on the line, at the line's size.
    const after = line.spans!.find((s) => s.text.includes('November'))!
    expect(after.rise).toBe(0)
    expect(after.size).toBeCloseTo(12, 1)
  })

  it('embeds every face the spans use', () => {
    const pdf = write([patch({
      text: 'Plain and slanted',
      spans: [{ text: 'Plain and ' }, { text: 'slanted', italic: true }],
    })])
    const line = lineWith(pdf, 'slanted')
    expect(line.spans!.some((s) => s.italic && s.text.includes('slanted'))).toBe(true)
  })
})

describe('patchRuns', () => {
  const base = { weight: 400, italic: false, color: [0, 0, 0] as [number, number, number] }

  it('is one run without spans', () => {
    expect(patchRuns({ ...base, text: 'Hello' })).toEqual([
      { text: 'Hello', weight: 400, italic: false, scale: 1, rise: 0, color: [0, 0, 0] },
    ])
  })

  it('ignores spans that do not spell the text, rather than drawing other words', () => {
    const runs = patchRuns({ ...base, text: 'Hello', spans: [{ text: 'Bye', weight: 700 }] })
    expect(runs).toHaveLength(1)
    expect(runs[0]!.text).toBe('Hello')
    expect(runs[0]!.weight).toBe(400)
  })

  it('resolves overrides against the patch', () => {
    const runs = patchRuns({
      ...base, text: 'ab', spans: [{ text: 'a' }, { text: 'b', weight: 700, color: [1, 0, 0] }],
    })
    expect(runs.map((r) => [r.text, r.weight, r.color])).toEqual([
      ['a', 400, [0, 0, 0]], ['b', 700, [1, 0, 0]],
    ])
  })

  it('truncates across run boundaries', () => {
    const runs = patchRuns({ ...base, text: 'abcdef', spans: [{ text: 'abc' }, { text: 'def', weight: 700 }] })
    expect(truncateRuns(runs, 4).map((r) => r.text)).toEqual(['abc', 'd'])
  })
})
