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

// Helpers are duplicated from shape.test.ts on purpose: a shared test helper
// module would couple every writer's test to every other writer's needs.
function docWith(objects: EditObject[]): EditDocument {
  return {
    version: EDIT_DOCUMENT_VERSION, sourceHash: '',
    pageOrder: ['p0'], pages: { p0: { sourceIndex: 0 } },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])), nextZ: 99,
  }
}

function sample(pdf: Uint8Array, x: number, y: number) {
  const doc = PdfDocument.open(pdf)
  try {
    const { width, rgba } = renderPage(doc, 0, 1)
    const i = (Math.round(y) * width + Math.round(x)) * 4
    return { r: rgba[i]!, g: rgba[i + 1]!, b: rgba[i + 2]! }
  } finally { doc.close() }
}

const fullPage = (): EditObject => ({
  pageId: 'p0', id: 'w1', kind: 'whiteout',
  rect: { x: 0, y: 0, w: 612, h: 792 },
  rotation: 0, z: 1, locked: false, opacity: 1, fill: [1, 1, 1],
} as EditObject)

describe('whiteout writer', () => {
  const geom = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }

  it('covers existing text with an opaque fill', () => {
    const out = replay(bytes('simple-text'), docWith([fullPage()]))
    // A full-page cover means no dark pixels survive anywhere.
    const doc = PdfDocument.open(out)
    try {
      const { rgba } = renderPage(doc, 0, 1)
      let dark = 0
      for (let i = 0; i < rgba.length; i += 4) if (rgba[i]! < 128) dark++
      expect(dark).toBe(0)
    } finally { doc.close() }
  })

  it('does NOT remove the underlying text — it is still extractable', () => {
    const out = replay(bytes('simple-text'), docWith([fullPage()]))
    const doc = PdfDocument.open(out)
    try {
      const page = doc._raw().loadPage(0)
      try {
        const text = page.toStructuredText('').asJSON()
        // This assertion is the FEATURE, not a bug. Whiteout is cosmetic and
        // this test is the executable record of that. If a future change made
        // this test fail, the tool would have silently become a redaction
        // tool -- and the UI copy promising otherwise would be a lie.
        expect(text).toContain('Hello margin')
      } finally { page.destroy() }
    } finally { doc.close() }
  })

  it('covers only its own rect, leaving the rest of the page alone', () => {
    const out = replay(bytes('simple-text'), docWith([{
      pageId: 'p0', id: 'w1', kind: 'whiteout',
      rect: { x: 60, y: 690, w: 200, h: 40 },
      rotation: 0, z: 1, locked: false, opacity: 1, fill: [1, 1, 1],
    } as EditObject]))
    const inside = pdfToView({ x: 160, y: 710 }, geom, 1)
    expect(sample(out, inside.x, inside.y).r).toBeGreaterThan(200)
    // The second line of body text sits well below the covered band.
    const doc = PdfDocument.open(out)
    try {
      const { width, height, rgba } = renderPage(doc, 0, 1)
      let darkBelow = 0
      for (let y = 120; y < height; y++) {
        for (let x = 0; x < width; x++) if (rgba[(y * width + x) * 4]! < 128) darkBelow++
      }
      expect(darkBelow).toBeGreaterThan(0)
    } finally { doc.close() }
  })

  it('paints a non-white cover in the colour it was given', () => {
    const out = replay(bytes('simple-text'), docWith([{
      pageId: 'p0', id: 'w1', kind: 'whiteout',
      rect: { x: 60, y: 690, w: 200, h: 40 },
      rotation: 0, z: 1, locked: false, opacity: 1, fill: [0, 0, 0],
    } as EditObject]))
    const c = pdfToView({ x: 160, y: 710 }, geom, 1)
    const px = sample(out, c.x, c.y)
    expect(px.r).toBeLessThan(40)
    expect(px.g).toBeLessThan(40)
  })
})
