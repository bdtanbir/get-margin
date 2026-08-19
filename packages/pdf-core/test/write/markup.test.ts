import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { replay } from '../../src/write/index.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument, type EditObject } from '../../src/write/types.js'
import { PdfDocument, renderPage, buildQuadIndex } from '../../src/index.js'
import { assertGolden } from '../golden.js'
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

/**
 * Quads for a real line of the fixture, taken from buildQuadIndex -- the
 * exact producer whose output setQuadPoints consumes in production. Using
 * hand-written numbers here would let a space mismatch between the two go
 * unnoticed, which is the single most likely way this feature breaks.
 */
function lineQuads(
  line = 0,
  from = 0,
  to = Infinity,
): { quads: number[][]; rect: { x: number; y: number; w: number; h: number } } {
  const doc = PdfDocument.open(bytes('simple-text'))
  try {
    const index = buildQuadIndex(doc, 0)
    const run = index.lines[line]
    if (!run) throw new Error(`fixture has no line ${line}`)
    const quad = mergeAll(run.chars.slice(from, to).map((c) => c.quad))
    const { cropBox } = doc.pageGeometry(0)
    const pageH = cropBox[3] - cropBox[1]
    // The object's own rect is raw bottom-up PDF space, unlike its quads.
    return {
      quads: [quad],
      rect: {
        x: quad[0]!, y: pageH - quad[5]!,
        w: quad[2]! - quad[0]!, h: quad[5]! - quad[1]!,
      },
    }
  } finally { doc.close() }
}

function mergeAll(quads: number[][]): number[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const q of quads) {
    for (let i = 0; i < 8; i += 2) {
      minX = Math.min(minX, q[i]!); maxX = Math.max(maxX, q[i]!)
      minY = Math.min(minY, q[i + 1]!); maxY = Math.max(maxY, q[i + 1]!)
    }
  }
  return [minX, minY, maxX, minY, minX, maxY, maxX, maxY]
}

function markupObject(
  kind: 'highlight' | 'underline' | 'strikeout',
  line = 0,
  color: [number, number, number] = [1, 0.9, 0.2],
  from = 0,
  to = Infinity,
): EditObject {
  const { quads, rect } = lineQuads(line, from, to)
  return {
    id: `m-${kind}-${line}-${from}`, pageId: 'p0', kind, quads, color, rect,
    rotation: 0, z: 1, locked: false, opacity: 1,
  } as EditObject
}

function annotationsOf(pdf: Uint8Array) {
  const doc = PdfDocument.open(pdf)
  try {
    const page = doc._raw().loadPage(0)
    try {
      return page.getAnnotations().map((a) => ({
        type: a.getType(),
        hasAP: a.getObject().get('AP').isDictionary(),
        quads: a.getQuadPoints().length,
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

describe('markup writer', () => {
  it.each([
    ['highlight', 'Highlight'],
    ['underline', 'Underline'],
    ['strikeout', 'StrikeOut'],
  ] as const)('writes %s as a native %s annotation with an /AP', (kind, subtype) => {
    const annots = annotationsOf(replay(bytes('simple-text'), docWith([markupObject(kind)])))
    expect(annots).toHaveLength(1)
    expect(annots[0]!.type).toBe(subtype)
    // Phase 0 verified /AP is a real written stream, not viewer-side
    // synthesis, for all three of these types.
    expect(annots[0]!.hasAP).toBe(true)
  })

  it('survives a save/reopen round trip with its quads intact', () => {
    const obj = markupObject('highlight') as EditObject & { quads: number[][] }
    const annots = annotationsOf(replay(bytes('simple-text'), docWith([obj])))
    expect(annots[0]!.quads).toBe(obj.quads.length)
  })

  // The whole point of the space contract: quads come from buildQuadIndex in
  // MuPDF page space and go into setQuadPoints unconverted. If either side
  // flipped y, the highlight would land on the mirror image of its text --
  // still plausible-looking on a symmetric page, which is why this samples
  // the actual glyphs.
  it('tints the page over the text it marks, not its mirror image', () => {
    const { quads } = lineQuads(0)
    const q = quads[0]!
    const cx = (q[0]! + q[2]!) / 2
    const cy = (q[1]! + q[5]!) / 2
    const out = replay(bytes('simple-text'), docWith([markupObject('highlight')]))
    const px = sample(out, cx, cy)
    expect(px.r).toBeGreaterThan(180)
    expect(px.b).toBeLessThan(180)

    // ...and the vertically mirrored position is untouched white.
    const doc = PdfDocument.open(bytes('simple-text'))
    let pageH = 0
    try { const g = doc.pageGeometry(0); pageH = g.cropBox[3] - g.cropBox[1] } finally { doc.close() }
    const mirror = sample(out, cx, pageH - cy)
    expect(mirror.r).toBeGreaterThan(200)
    expect(mirror.g).toBeGreaterThan(200)
    expect(mirror.b).toBeGreaterThan(200)
  })

  it('writes one annotation per markup object', () => {
    const out = replay(bytes('simple-text'), docWith([
      markupObject('highlight', 0),
      markupObject('underline', 1),
    ]))
    expect(annotationsOf(out)).toHaveLength(2)
  })

  it('matches the reviewed golden', async () => {
    // The fixture has two lines, so the third mark takes the back half of
    // the second rather than a line that does not exist.
    await assertGolden('export-markup', replay(bytes('simple-text'), docWith([
      markupObject('highlight', 0),
      markupObject('underline', 1, [0, 0.4, 1], 0, 20),
      markupObject('strikeout', 1, [1, 0.1, 0.1], 22),
    ])))
  })
})
