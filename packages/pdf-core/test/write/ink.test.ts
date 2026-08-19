import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { replay } from '../../src/write/index.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument, type EditObject } from '../../src/write/types.js'
import { PdfDocument, renderPage } from '../../src/index.js'
import { pdfToView } from '@margin/transform'
import { generateFixtures, fixturePath } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: Parameters<typeof fixturePath>[0]): Uint8Array =>
  new Uint8Array(readFileSync(fixturePath(n)))

function docWith(objects: EditObject[]): EditDocument {
  return {
    version: EDIT_DOCUMENT_VERSION, sourceHash: '',
    pageOrder: ['p0'], pages: { p0: { sourceIndex: 0 } },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])), nextZ: 99,
  }
}

/** A horizontal stroke at PDF y=400 from x=100 to x=300, and a second below it. */
function inkObject(strokes: number[][], color: [number, number, number] = [1, 0, 0]): EditObject {
  const xs = strokes.flatMap((s) => s.filter((_, i) => i % 2 === 0))
  const ys = strokes.flatMap((s) => s.filter((_, i) => i % 2 === 1))
  return {
    id: 'k1', pageId: 'p0', kind: 'ink', strokes, color, strokeWidth: 4,
    rect: {
      x: Math.min(...xs) - 4, y: Math.min(...ys) - 4,
      w: Math.max(...xs) - Math.min(...xs) + 8, h: Math.max(...ys) - Math.min(...ys) + 8,
    },
    rotation: 0, z: 1, locked: false, opacity: 1,
  } as EditObject
}

const LINE = [100, 400, 200, 400, 300, 400]
const SECOND = [100, 350, 300, 350]

function annotationsOf(pdf: Uint8Array): Array<{ type: string; hasAP: boolean; strokes: number }> {
  const doc = PdfDocument.open(pdf)
  try {
    const page = doc._raw().loadPage(0)
    try {
      return page.getAnnotations().map((a) => ({
        type: a.getType(),
        hasAP: a.getObject().get('AP').isDictionary(),
        strokes: a.getInkList().length,
      }))
    } finally { page.destroy() }
  } finally { doc.close() }
}

function sample(pdf: Uint8Array, x: number, y: number) {
  const doc = PdfDocument.open(pdf)
  try {
    const { width, rgba } = renderPage(doc, 0, 1)
    const i = (Math.round(y) * width + Math.round(x)) * 4
    return { r: rgba[i]!, g: rgba[i + 1]!, b: rgba[i + 2]! }
  } finally { doc.close() }
}

describe('ink writer', () => {
  const geom = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }

  it('exports a native Ink annotation, not content-stream paths', () => {
    const annots = annotationsOf(replay(bytes('simple-text'), docWith([inkObject([LINE])])))
    expect(annots).toHaveLength(1)
    expect(annots[0]!.type).toBe('Ink')
  })

  it('gives the annotation an appearance stream', () => {
    // Without /AP a viewer that does not synthesise one shows nothing.
    expect(annotationsOf(replay(bytes('simple-text'), docWith([inkObject([LINE])])))[0]!.hasAP).toBe(true)
  })

  it('keeps each stroke separate rather than joining them into one', () => {
    const annots = annotationsOf(replay(bytes('simple-text'), docWith([inkObject([LINE, SECOND])])))
    expect(annots[0]!.strokes).toBe(2)
  })

  it('renders visible ink along the stroke path', () => {
    const out = replay(bytes('simple-text'), docWith([inkObject([LINE])]))
    const c = pdfToView({ x: 200, y: 400 }, geom, 1)
    const px = sample(out, c.x, c.y)
    expect(px.r).toBeGreaterThan(150)
    expect(px.g).toBeLessThan(100)
  })

  // Convention A: annotation setters are TOP-DOWN page space. Handing them
  // raw bottom-up PDF points mirrors every stroke vertically -- and on this
  // page that still looks like a plausible squiggle, which is exactly why
  // it needs pinning rather than eyeballing.
  it('does not mirror the stroke vertically', () => {
    // One stroke high on the page. If y were unflipped it would render near
    // the bottom instead.
    const high = [100, 700, 300, 700]
    const out = replay(bytes('simple-text'), docWith([inkObject([high])]))
    const at = pdfToView({ x: 200, y: 700 }, geom, 1)
    const mirrored = pdfToView({ x: 200, y: 92 }, geom, 1)
    expect(sample(out, at.x, at.y).r).toBeGreaterThan(150)
    const wrong = sample(out, mirrored.x, mirrored.y)
    expect(wrong.r).toBeGreaterThan(200)
    expect(wrong.g).toBeGreaterThan(200)
  })

  it('places ink correctly on a quarter-turned page', () => {
    const doc = PdfDocument.open(bytes('rotated'))
    let g
    try { g = doc.pageGeometry(0) } finally { doc.close() }
    const [x0, y0] = g.cropBox
    const stroke = [x0 + 100, y0 + 200, x0 + 300, y0 + 200]
    const out = replay(bytes('rotated'), docWith([inkObject([stroke])]))
    const c = pdfToView({ x: x0 + 200, y: y0 + 200 }, g, 1)
    const px = sample(out, c.x, c.y)
    expect(px.r).toBeGreaterThan(150)
    expect(px.g).toBeLessThan(100)
  })

  it('ignores a trailing unpaired coordinate rather than throwing', () => {
    const out = replay(bytes('simple-text'), docWith([inkObject([[100, 400, 200, 400, 300]])]))
    expect(annotationsOf(out)[0]!.type).toBe('Ink')
  })
})
