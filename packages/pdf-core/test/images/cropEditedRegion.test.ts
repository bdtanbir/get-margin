import { describe, it, expect } from 'vitest'
import * as mupdf from 'mupdf'
import { PDFDocument, rgb } from 'pdf-lib'
import { emptyEditDocument, type EditDocument, type EditObject } from '../../src/index.js'
import { cropEditedRegion } from '../../src/write/editedRegion.js'

/**
 * Two blank pages, so that "the object on page two" and "the crop of page
 * one" are distinguishable, and a blue square on page one for the
 * document's own ink.
 *
 * The blue square is at 300,300..360,360 in PDF space, which is
 * 300,432..360,492 top-down on a 792pt page.
 */
async function twoPages(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const first = doc.addPage([612, 792])
  first.drawRectangle({ x: 300, y: 300, width: 60, height: 60, color: rgb(0.1, 0.1, 0.9) })
  doc.addPage([612, 792])
  return doc.save()
}

const src = await twoPages()
const sources = () => new Map([['src-0', src]])

/** A filled red rect object, in PDF space (bottom-up). */
function redRect(id: string, pageId: string, rect: { x: number; y: number; w: number; h: number }): EditObject {
  return {
    id, pageId, kind: 'rect', rect, rotation: 0, z: 1, locked: false, opacity: 1,
    fill: [1, 0, 0], stroke: null, strokeWidth: 0,
  } as EditObject
}

function docWith(objects: EditObject[], rotation = 0): EditDocument {
  return {
    ...emptyEditDocument(),
    sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: ['p0', 'p1'],
    pages: {
      p0: { sourceId: 'src-0', sourceIndex: 0, rotation, cropBox: null },
      p1: { sourceId: 'src-0', sourceIndex: 1, rotation: 0, cropBox: null },
    },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
  }
}

function decode(png: Uint8Array) {
  const image = new mupdf.Image(png)
  const px = image.toPixmap()
  try {
    return {
      width: px.getWidth(),
      height: px.getHeight(),
      pixels: new Uint8Array(px.getPixels()),
      components: px.getNumberOfComponents(),
    }
  } finally { px.destroy(); image.destroy() }
}

const middle = (png: Uint8Array) => {
  const { pixels, components } = decode(png)
  const at = Math.floor(pixels.length / components / 2) * components
  return { r: pixels[at]!, g: pixels[at + 1]!, b: pixels[at + 2]! }
}

/** Red rect at 100,600..200,700 bottom-up is 100,92..200,192 top-down. */
const RED_PDF = { x: 100, y: 600, w: 100, h: 100 }
const RED_PAGE = { x: 100, y: 92, w: 100, h: 100 }

describe('cropEditedRegion', () => {
  /**
   * The whole reason this exists. A lift used to rasterise the SOURCE
   * page, so a value the user had already changed came back in the lifted
   * copy as the document originally said it.
   */
  it('carries the edits drawn on the page, not just its original ink', () => {
    const out = cropEditedRegion(sources(), docWith([redRect('r', 'p0', RED_PDF)]), 'p0', RED_PAGE, 1)
    const p = middle(out!.data)
    expect(p.r).toBeGreaterThan(200)
    expect(p.g).toBeLessThan(60)
  })

  it('still carries the ink the document came with', () => {
    const out = cropEditedRegion(
      sources(), docWith([redRect('r', 'p0', RED_PDF)]), 'p0', { x: 300, y: 432, w: 60, h: 60 }, 1,
    )
    const p = middle(out!.data)
    expect(p.b).toBeGreaterThan(150)
    expect(p.r).toBeLessThan(100)
  })

  it('draws only the objects that belong to the page being lifted', () => {
    // The red rect is on page two; a lift of page one at the same spot is paper.
    const out = cropEditedRegion(sources(), docWith([redRect('r', 'p1', RED_PDF)]), 'p0', RED_PAGE, 1)
    const p = middle(out!.data)
    expect(p.r).toBeGreaterThan(240)
    expect(p.g).toBeGreaterThan(240)
  })

  it('lifts the page the id names, whatever its position in the source', () => {
    const out = cropEditedRegion(sources(), docWith([redRect('r', 'p1', RED_PDF)]), 'p1', RED_PAGE, 1)
    const p = middle(out!.data)
    expect(p.r).toBeGreaterThan(200)
    expect(p.g).toBeLessThan(60)
  })

  it('is a plain crop of the source when the page carries no edits', () => {
    const out = cropEditedRegion(sources(), docWith([]), 'p0', { x: 300, y: 432, w: 60, h: 60 }, 1)
    const p = middle(out!.data)
    expect(p.b).toBeGreaterThan(150)
    const { width } = decode(out!.data)
    expect(width).toBeCloseTo(60, -1)
  })

  /**
   * The overlay the user drags on shows the page with the edit store's
   * rotation folded in, so the rectangle it hands over is in THAT space.
   * A page turned a quarter in the app is 792 wide: the blue square at
   * 300,432 upright lands at 300,300 turned clockwise.
   */
  it('takes the rectangle in the space of the page as the user sees it', () => {
    const out = cropEditedRegion(sources(), docWith([], 90), 'p0', { x: 300, y: 300, w: 60, h: 60 }, 1)
    const p = middle(out!.data)
    expect(p.b).toBeGreaterThan(150)
    expect(p.r).toBeLessThan(100)
  })

  it('leaves the source bytes alone', () => {
    const map = sources()
    cropEditedRegion(map, docWith([redRect('r', 'p0', RED_PDF)]), 'p0', RED_PAGE, 1)
    expect(map.get('src-0')).toBe(src)
    expect(src.length).toBeGreaterThan(0)
  })

  it('refuses a page the edit document does not have', () => {
    expect(cropEditedRegion(sources(), docWith([]), 'nope', RED_PAGE, 1)).toBeUndefined()
  })
})
