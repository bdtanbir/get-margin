import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { replay } from '../../src/write/index.js'
import { prependContent } from '../../src/write/content.js'
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

/**
 * `simple-text` with an opaque white rectangle painted under it.
 *
 * Stands in for the very common real file this feature exists for: anything
 * printed from a browser paints its own white background across the sheet,
 * so the page is not white by default -- it is white because something drew
 * white there. Built here rather than added to the fixture set because it is
 * one writer's edge case, not a shape the whole suite needs.
 */
function whitePaintedPage(): Uint8Array {
  const raw = mupdf.PDFDocument.openDocument(
    bytes('simple-text'), 'application/pdf',
  ) as mupdf.PDFDocument
  const page = raw.loadPage(0)
  try {
    prependContent(raw, page, '1 1 1 rg\n0 0 612 792 re f')
    return raw.saveToBuffer('compress').asUint8Array()
  } finally {
    page.destroy()
    raw.destroy()
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

/**
 * How many pixels are near-black in EVERY channel.
 *
 * All three channels, not the red one: a teal tint takes red to zero across
 * the whole sheet, so a red-channel threshold would count the entire page as
 * ink and measure nothing. Multiplying black by any colour leaves it black,
 * so this count is what must survive a tint exactly.
 */
function inkPixels(pdf: Uint8Array, index = 0): number {
  const doc = PdfDocument.open(pdf)
  try {
    const { rgba } = renderPage(doc, index, 1)
    let ink = 0
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i]! < 60 && rgba[i + 1]! < 60 && rgba[i + 2]! < 60) ink++
    }
    return ink
  } finally { doc.close() }
}

describe('page background', () => {
  it('tints the whole page in the chosen colour', () => {
    const out = replay(new Map([[SRC, bytes('simple-text')]]), docWith(1, 0, TEAL))
    // A corner, which no fixture text reaches: nothing but the background
    // can be responsible for the colour there. Multiply against white paper
    // reproduces the colour exactly.
    const px = sample(out, 0, 4, 4)
    expect(px.r).toBeLessThan(20)
    expect(px.g).toBeGreaterThan(110)
    expect(px.g).toBeLessThan(145)
    expect(px.b).toBeGreaterThan(110)
    expect(px.b).toBeLessThan(145)
  })

  /**
   * THE REASON THIS IS A MULTIPLY AND NOT AN OPAQUE FILL. A plain fill over
   * the content would pass the corner check above while having erased every
   * word on the page, and the two are indistinguishable from the corner
   * alone. Multiply is `backdrop x source`, so black text multiplied by any
   * colour is still black -- there is no colour the user can pick that hides
   * their document.
   */
  it('cannot hide the page content', () => {
    const src = bytes('simple-text')
    const before = inkPixels(src)
    expect(before).toBeGreaterThan(0)
    // Not equality: multiply can only DARKEN, so an antialiased glyph edge
    // that was grey on white can cross the threshold once the page is tinted.
    // That direction is fine and is the point -- what must never happen is
    // the count falling, which is what a fill over the content produces.
    expect(inkPixels(replay(new Map([[SRC, src]]), docWith(1, 0, TEAL))))
      .toBeGreaterThanOrEqual(before)
  })

  /**
   * THE REASON THIS IS NOT A FILL UNDER THE CONTENT, which is the obvious
   * implementation and the one that fails on most real files. A page printed
   * from a browser paints its own opaque white across the whole sheet, and a
   * fill beneath that is invisible -- the export looked untouched while the
   * edit document said otherwise.
   *
   * The fixture here is built to be exactly that shape: white painted, not
   * white by default.
   */
  it('tints a page that paints its own opaque white background', () => {
    const src = whitePaintedPage()
    // Precondition: the source really does paint, so this is testing what it
    // claims to. Every pixel opaque is what a browser-printed page looks like.
    const doc = PdfDocument.open(src)
    try {
      const { rgba } = renderPage(doc, 0, 1)
      let transparent = 0
      for (let i = 3; i < rgba.length; i += 4) if (rgba[i]! < 255) transparent++
      expect(transparent).toBe(0)
    } finally { doc.close() }

    const out = replay(new Map([[SRC, src]]), docWith(1, 0, TEAL))
    const px = sample(out, 0, 4, 4)
    expect(px.r).toBeLessThan(20)
    expect(px.g).toBeGreaterThan(110)
    expect(px.b).toBeGreaterThan(110)
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
   * The tint goes down BEFORE the object writers, so the user's own text is
   * drawn ON the tinted page rather than seen through it. A white text object
   * is the case that tells the two apart: on top of the tint it stays white,
   * and under it would come out the tint's colour.
   */
  it('goes under the objects the user drew, not over them', () => {
    const label = {
      id: 't1', pageId: 'p0', kind: 'text',
      rect: { x: 100, y: 400, w: 400, h: 60 },
      rotation: 0, z: 1, locked: false, opacity: 1,
      text: 'WHITE', fontFamily: 'Inter', bold: false, italic: false,
      fontSize: 48, color: [1, 1, 1] as Color, align: 'left',
    } as unknown as EditObject

    const out = replay(
      new Map([[SRC, bytes('simple-text')]]),
      docWith(1, 0, TEAL, [label]),
      { fonts: FONTS },
    )
    const doc = PdfDocument.open(out)
    try {
      const { width, height, rgba } = renderPage(doc, 0, 1)
      // Somewhere in the label's box there must be a pixel that is still
      // white. Under the tint there would not be one.
      let white = 0
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4
          if (rgba[i]! > 240 && rgba[i + 1]! > 240 && rgba[i + 2]! > 240) white++
        }
      }
      expect(white).toBeGreaterThan(0)
    } finally { doc.close() }
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
