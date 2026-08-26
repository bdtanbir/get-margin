import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replay } from '../../src/write/index.js'
import {
  EDIT_DOCUMENT_VERSION, emptyEditDocument,
  type Color, type EditDocument, type EditObject,
} from '../../src/write/types.js'
import { PdfDocument, renderPage } from '../../src/index.js'
import { generateFixtures, fixturePath, type FixtureName } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: FixtureName): Uint8Array => new Uint8Array(readFileSync(fixturePath(n)))
const SRC = 'src-0'

const TEAL: Color = [0, 0.5, 0.5]

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const FONTS = new Map([[
  'Inter', new Uint8Array(readFileSync(join(ROOT, 'apps/web/public/fonts/Inter.ttf'))),
]])

/** `pageCount` pages from one source, with `background` on page `target`. */
function docWith(
  pageCount: number,
  target: number,
  background: Color | undefined,
  objects: EditObject[] = [],
): EditDocument {
  return {
    ...emptyEditDocument(),
    version: EDIT_DOCUMENT_VERSION,
    sources: { [SRC]: { hash: '', name: 'a.pdf' } },
    pageOrder: Array.from({ length: pageCount }, (_, i) => `p${i}`),
    pages: Object.fromEntries(Array.from({ length: pageCount }, (_, i) => [
      `p${i}`,
      {
        sourceId: SRC, sourceIndex: i, rotation: 0, cropBox: null,
        ...(i === target && background ? { background } : {}),
      },
    ])),
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    nextZ: 99,
  }
}

/** A rendered pixel, in 0..255 channels. */
function sample(pdf: Uint8Array, index: number, x: number, y: number) {
  const doc = PdfDocument.open(pdf)
  try {
    const { width, rgba } = renderPage(doc, index, 1)
    const i = (Math.round(y) * width + Math.round(x)) * 4
    return { r: rgba[i]!, g: rgba[i + 1]!, b: rgba[i + 2]! }
  } finally { doc.close() }
}

/** How many pixels on the page are darker than mid-grey. */
function darkPixels(pdf: Uint8Array, index = 0): number {
  const doc = PdfDocument.open(pdf)
  try {
    const { rgba } = renderPage(doc, index, 1)
    let dark = 0
    for (let i = 0; i < rgba.length; i += 4) if (rgba[i]! < 128) dark++
    return dark
  } finally { doc.close() }
}

describe('page background', () => {
  it('paints the whole page in the chosen colour', () => {
    const out = replay(new Map([[SRC, bytes('simple-text')]]), docWith(1, 0, TEAL))
    // A corner, which no fixture text reaches: nothing but the background
    // can be responsible for the colour there.
    const px = sample(out, 0, 4, 4)
    expect(px.r).toBeLessThan(20)
    expect(px.g).toBeGreaterThan(110)
    expect(px.g).toBeLessThan(145)
    expect(px.b).toBeGreaterThan(110)
    expect(px.b).toBeLessThan(145)
  })

  /**
   * THE WHOLE POINT of prepending rather than appending. An `appendContent`
   * background is a coloured rectangle drawn OVER the document -- it would
   * pass the corner check above while having hidden every word on the page,
   * and the two are indistinguishable from the corner alone.
   */
  it('goes UNDER the page content, which is still visible over it', () => {
    const src = bytes('simple-text')
    const before = darkPixels(src)
    expect(before).toBeGreaterThan(0)

    const out = replay(new Map([[SRC, src]]), docWith(1, 0, TEAL))
    // The glyphs are black on teal rather than black on white, so the count
    // shifts slightly with antialiasing -- but it must not collapse to zero,
    // which is what being painted over looks like.
    expect(darkPixels(out)).toBeGreaterThan(before * 0.5)
  })

  it('paints only the page it was set on', () => {
    const out = replay(new Map([[SRC, bytes('multi-page')]]), docWith(3, 1, TEAL))
    expect(sample(out, 1, 4, 4).g).toBeGreaterThan(110)
    // Page 0 keeps the nothing it was: MuPDF renders unpainted areas white
    // through the opaque path and near-white here.
    expect(sample(out, 0, 4, 4).r).toBeGreaterThan(240)
    expect(sample(out, 2, 4, 4).r).toBeGreaterThan(240)
  })

  /**
   * The rect comes from `geometryOf`, which reads the page AFTER
   * applyPageBoxes. A background derived from the source box instead would
   * be offset by the crop on any page whose CropBox origin is not (0,0) --
   * invisible on a letter page starting at zero, which is every fixture but
   * this one.
   */
  it('fills a page whose CropBox origin is not zero', () => {
    const src = bytes('offset-cropbox')
    const out = replay(new Map([[SRC, src]]), docWith(1, 0, TEAL))
    const doc = PdfDocument.open(out)
    let w = 0, h = 0
    try {
      const r = renderPage(doc, 0, 1)
      w = r.width
      h = r.height
    } finally { doc.close() }
    // Both far corners, so an offset error in either axis shows up.
    for (const [x, y] of [[4, 4], [w - 5, h - 5]] as const) {
      const px = sample(out, 0, x, y)
      expect(px.g).toBeGreaterThan(110)
      expect(px.b).toBeGreaterThan(110)
    }
  })

  it('fills a crop the user drew, not the box the file was opened with', () => {
    const doc = docWith(1, 0, TEAL)
    doc.pages.p0!.cropBox = [100, 200, 400, 600]
    const out = replay(new Map([[SRC, bytes('simple-text')]]), doc)
    // The render is now 300x400; a corner of it is inside the crop, which
    // the background must reach.
    expect(sample(out, 0, 4, 4).g).toBeGreaterThan(110)
  })

  /**
   * A watermark asks to be drawn behind the content and the background asks
   * to be drawn behind everything -- both prepend, and the one that prepends
   * LAST ends up at the bottom. If this ordering ever flips, the watermark
   * is painted over and vanishes without any error.
   */
  it('sits under a behind-the-content stamp rather than over it', () => {
    const stamp = {
      id: 's1', pageId: 'p0', kind: 'stamp', stampKind: 'watermark',
      rect: { x: 50, y: 300, w: 500, h: 100 },
      rotation: 0, z: 1, locked: false, opacity: 1,
      text: 'DRAFT', fontFamily: 'Inter', fontSize: 72,
      color: [0, 0, 0] as Color, align: 'center', behind: true,
    } as unknown as EditObject

    const opts = { fonts: FONTS }
    const withStamp = replay(new Map([[SRC, bytes('simple-text')]]), docWith(1, 0, undefined, [stamp]), opts)
    const withBoth = replay(new Map([[SRC, bytes('simple-text')]]), docWith(1, 0, TEAL, [stamp]), opts)
    // The stamp's own dark pixels survive the background being added.
    expect(darkPixels(withBoth)).toBeGreaterThan(darkPixels(withStamp) * 0.5)
  })

  /**
   * The pass-through tier hands back the user's original bytes when the edit
   * describes exactly the file they opened. A background is an edit; without
   * the guard in `replay` it would be silently discarded at Download.
   */
  it('is not discarded by the untouched-document pass-through', () => {
    const src = bytes('simple-text')
    const out = replay(new Map([[SRC, src]]), docWith(1, 0, TEAL))
    expect(out).not.toEqual(src)
    expect(sample(out, 0, 4, 4).g).toBeGreaterThan(110)
  })

  it('leaves a document with no background byte-identical', () => {
    const src = bytes('simple-text')
    const out = replay(new Map([[SRC, src]]), docWith(1, 0, undefined))
    expect(out).toEqual(src)
  })
})
