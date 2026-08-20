import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import * as mupdf from 'mupdf'
import { replay } from '../../src/write/index.js'
import { emptyEditDocument, type EditDocument, type EditObject } from '../../src/write/types.js'
import { generateFixtures, fixturePath } from '../fixtures/index.js'

beforeAll(async () => {
  await generateFixtures()
}, 60_000)

const src = (): Uint8Array => new Uint8Array(readFileSync(fixturePath('simple-text')))

/**
 * A page whose content leaves a transform applied, the way Chromium's does.
 *
 * Chromium opens every page it prints with a top-level `cm` outside any
 * q/Q -- `.24 0 0 -.24 0 842.88 cm` -- so the CTM at the END of the page is
 * a quarter-scale Y-flip. Anything appended after it inherits that.
 *
 * This reproduces the shape rather than the exact numbers: a doubling scale
 * is easier to reason about, and any unbalanced transform demonstrates the
 * same defect. The rest of the page is untouched.
 */
function withDanglingTransform(pdf: Uint8Array, ops = '2 0 0 2 0 0 cm'): Uint8Array {
  const doc = mupdf.PDFDocument.openDocument(Buffer.from(pdf), 'application/pdf')
  const page = doc.loadPage(0)
  const obj = page.getObject()
  const contents = obj.get('Contents')

  const prefix = doc.addStream(`${ops}\n`, {})
  const array = doc.newArray()
  array.push(prefix)
  if (contents.isArray()) {
    for (let i = 0; i < contents.length; i++) array.push(contents.get(i))
  } else {
    array.push(contents)
  }
  obj.put('Contents', array)
  return new Uint8Array(doc.saveToBuffer('').asUint8Array())
}

function docWith(objects: EditObject[]): EditDocument {
  return {
    ...emptyEditDocument(),
    sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: ['p0'],
    pages: { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
  }
}

/**
 * A RED box at a known place, in raw PDF coordinates.
 *
 * Red because the fixture's own text is black, and a black probe would be
 * indistinguishable from the page it is drawn on -- the first version of
 * this test measured the fixture's text and reported it as the box.
 */
const box = (id: string): EditObject =>
  ({
    pageId: 'p0',
    id,
    kind: 'whiteout',
    rect: { x: 100, y: 600, w: 120, h: 60 },
    rotation: 0,
    z: 1,
    locked: false,
    opacity: 1,
    fill: [1, 0, 0],
  }) as EditObject

/** Where the ink actually landed, in PDF points from the bottom-left. */
function inkBounds(pdf: Uint8Array): { x0: number; y0: number; x1: number; y1: number } | null {
  const doc = mupdf.Document.openDocument(Buffer.from(pdf), 'application/pdf')
  const page = doc.loadPage(0)
  const pm = page.toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false, true)
  const w = pm.getWidth()
  const h = pm.getHeight()
  const px = pm.getPixels()

  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      if (px[i]! > 180 && px[i + 1]! < 70 && px[i + 2]! < 70) {
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
    }
  }
  if (x0 === Infinity) return null
  // Device y counts down from the top; the rect was given in PDF space.
  return { x0, y0: h - y1, x1, y1: h - y0 }
}

/**
 * Appended content must be drawn against the page's INITIAL transform.
 *
 * Reported as a text patch landing in the wrong place on a downloaded file
 * while looking correct in the editor. The editor draws its own overlay;
 * the export appends to the page, and inherited whatever the page had left
 * applied. See `docs/findings/25-dangling-transform.md`.
 */
describe('appending to a page that left a transform applied', () => {
  it('draws at the requested coordinates, not the inherited ones', () => {
    const hostile = withDanglingTransform(src())
    const out = replay(new Map([['src-0', hostile]]), docWith([box('b1')]))

    const ink = inkBounds(out)
    expect(ink, 'nothing was drawn at all').not.toBeNull()

    // Asked for x 100..220, y 600..660. A doubled CTM would put it at
    // x 200..440 and off the top of the page.
    expect(ink!.x0).toBeGreaterThan(95)
    expect(ink!.x0).toBeLessThan(110)
    expect(ink!.y0).toBeGreaterThan(590)
    expect(ink!.y0).toBeLessThan(615)
  })

  /** The same page, unmolested, must be unaffected by the fix. */
  it('is unchanged for a page that balances its own operators', () => {
    const out = replay(new Map([['src-0', src()]]), docWith([box('b1')]))
    const ink = inkBounds(out)

    expect(ink).not.toBeNull()
    expect(ink!.x0).toBeGreaterThan(95)
    expect(ink!.x0).toBeLessThan(110)
    expect(ink!.y0).toBeGreaterThan(590)
    expect(ink!.y0).toBeLessThan(615)
  })

  /**
   * Several objects on one page must not nest the bracket once per object.
   *
   * They all land in the same place, and the page is wrapped once however
   * many are appended.
   */
  it('wraps the page once however many fragments are appended', () => {
    const hostile = withDanglingTransform(src())
    const many = [box('b1'), { ...box('b2'), rect: { x: 300, y: 600, w: 60, h: 60 } } as EditObject]
    const out = replay(new Map([['src-0', hostile]]), docWith(many))

    const doc = mupdf.PDFDocument.openDocument(Buffer.from(out), 'application/pdf')
    const contents = doc.loadPage(0).getObject().get('Contents')
    expect(contents.isArray()).toBe(true)

    // open + original + close + one stream per object.
    let guards = 0
    for (let i = 0; i < contents.length; i++) {
      if (!contents.get(i).get('MarginContentGuard').isNull()) guards++
    }
    expect(guards, 'the page was bracketed more than once').toBe(1)

    const ink = inkBounds(out)
    expect(ink!.x0).toBeGreaterThan(95)
    expect(ink!.x1).toBeLessThan(370)
  })

  /**
   * The page's own content must still be visible: the bracket wraps it, it
   * does not replace it.
   */
  it('leaves the page own content drawn', () => {
    const hostile = withDanglingTransform(src(), '1 0 0 1 0 0 cm')
    const out = replay(new Map([['src-0', hostile]]), docWith([]))

    const doc = mupdf.Document.openDocument(Buffer.from(out), 'application/pdf')
    const chars: string[] = []
    doc
      .loadPage(0)
      .toStructuredText('')
      .walk({ onChar: (c: string) => chars.push(c) })
    expect(chars.join('')).toContain('Hello margin')
  })
})
