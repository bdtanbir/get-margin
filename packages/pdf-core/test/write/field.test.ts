import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import * as mupdf from 'mupdf'
import { replay } from '../../src/write/index.js'
import {
  emptyEditDocument, type EditDocument, type EditObject, type FieldObject,
} from '../../src/write/types.js'
import { generateFixtures, fixturePath, type FixtureName } from '../fixtures/index.js'
import { geometryFromPageObject } from '../../src/geometry.js'
import { toAnnotSpace } from '../../src/write/coords.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: FixtureName): Uint8Array => new Uint8Array(readFileSync(fixturePath(n)))

function docWith(objects: EditObject[], pages = 1): EditDocument {
  return {
    ...emptyEditDocument(),
    sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: Array.from({ length: pages }, (_, i) => `p${i}`),
    pages: Object.fromEntries(
      Array.from({ length: pages }, (_, i) => [
        `p${i}`, { sourceIndex: i, sourceId: 'src-0', rotation: 0, cropBox: null },
      ]),
    ),
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    nextZ: 99,
  }
}

export function field(over: Partial<FieldObject> = {}): FieldObject {
  return {
    id: 'f1', pageId: 'p0', kind: 'field',
    rect: { x: 100, y: 400, w: 200, h: 24 },
    rotation: 0, z: 1, locked: false, opacity: 1,
    fieldType: 'text', name: 'fullname', group: null, exportValue: null,
    value: '', options: [], required: false, readOnly: false,
    multiline: false, maxLength: null, fontSize: 12,
    ...over,
  }
}

/**
 * Read the exported document's widgets.
 *
 * ALWAYS through a reopen. Findings 12 5 measured that a widget added by
 * raw object work is invisible to getWidgets() on a live document -- so a
 * test asserting on the document it just built reads zero widgets and looks
 * exactly like a creation failure.
 */
export function widgetsOf(pdf: Uint8Array, page = 0) {
  const doc = mupdf.PDFDocument.openDocument(pdf, 'application/pdf') as mupdf.PDFDocument
  const p = doc.loadPage(page)
  try {
    return p.getWidgets().map((w) => ({
      name: w.getName(),
      type: w.getFieldType(),
      value: w.getValue(),
      flags: w.getFieldFlags(),
      readOnly: w.isReadOnly(),
      multiline: w.isMultiline(),
      maxLen: w.getMaxLen(),
      bounds: [...w.getBounds()],
      options: w.getOptions(),
    }))
  } finally { p.destroy(); doc.destroy() }
}

/** The page box, so a rect can be asserted to land inside it. */
function pageBounds(pdf: Uint8Array, page = 0): number[] {
  const doc = mupdf.PDFDocument.openDocument(pdf, 'application/pdf') as mupdf.PDFDocument
  const p = doc.loadPage(page)
  try { return [...p.getBounds()] } finally { p.destroy(); doc.destroy() }
}

/**
 * Where a rect written in raw user space SHOULD read back from
 * getBounds(), which reports Convention A.
 *
 * This is the whole geometry assertion, and it has to be exact. A
 * containment check passes for a field written in the wrong space -- the
 * page's top is as much "inside the page" as its bottom -- which is
 * precisely how the first version of this writer shipped a bug that three
 * of four rotations did not notice.
 */
function expectedBounds(pdf: Uint8Array, rect: EditObject['rect'], page = 0): number[] {
  const doc = mupdf.PDFDocument.openDocument(pdf, 'application/pdf') as mupdf.PDFDocument
  const p = doc.loadPage(page)
  try {
    return toAnnotSpace(rect, geometryFromPageObject(p.getObject()))
  } finally { p.destroy(); doc.destroy() }
}

const write = (objects: EditObject[], fixture: FixtureName = 'simple-text', pages = 1) =>
  replay(new Map([['src-0', bytes(fixture)]]), docWith(objects, pages))

describe('text field writer', () => {
  it('writes a field that survives save and reopen', () => {
    const w = widgetsOf(write([field({ name: 'fullname', value: 'Ada' })]))
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ name: 'fullname', type: 'text', value: 'Ada' })
  })

  it('carries multiline, read-only, and required', () => {
    const w = widgetsOf(write([
      field({ id: 'a', name: 'plain' }),
      field({ id: 'b', name: 'notes', multiline: true, rect: { x: 100, y: 300, w: 200, h: 60 } }),
      field({ id: 'c', name: 'locked', readOnly: true, rect: { x: 100, y: 200, w: 200, h: 24 } }),
      field({ id: 'd', name: 'must', required: true, rect: { x: 100, y: 100, w: 200, h: 24 } }),
    ]))
    const by = Object.fromEntries(w.map((f) => [f.name, f]))
    expect(by.plain!.multiline).toBe(false)
    expect(by.notes!.multiline).toBe(true)
    expect(by.locked!.readOnly).toBe(true)
    expect(by.must!.flags & 2).toBe(2)
  })

  it('carries a maximum length', () => {
    expect(widgetsOf(write([field({ maxLength: 10 })]))[0]!.maxLen).toBe(10)
  })

  // A field with no name cannot hold a value -- the format addresses
  // values by name -- so this fails the export rather than producing a
  // form that silently discards what is typed into it.
  it('refuses a field with no name', () => {
    expect(() => write([field({ name: '  ' })])).toThrow(/name/)
  })

  it('names the page and the object when a field fails', () => {
    expect(() => write([field({ name: '' })])).toThrow(/field on page 1/)
  })
})

describe('AcroForm wiring', () => {
  const acroOf = (pdf: Uint8Array) => {
    const doc = mupdf.PDFDocument.openDocument(pdf, 'application/pdf') as mupdf.PDFDocument
    try {
      const acro = doc.getTrailer().get('Root').get('AcroForm')
      if (!acro.isDictionary()) return null
      const names: string[] = []
      acro.get('Fields').forEach((f) => names.push(f.get('T').asString()))
      return {
        fields: names,
        da: acro.get('DA').asString(),
        hasHelv: !acro.get('DR').get('Font').get('Helv').isNull(),
      }
    } finally { doc.destroy() }
  }

  it('creates /AcroForm with a default appearance and its font', () => {
    const acro = acroOf(write([field()]))
    expect(acro?.fields).toEqual(['fullname'])
    expect(acro?.da).toContain('Helv')
    expect(acro?.hasHelv).toBe(true)
  })

  it('registers every field once, across pages', () => {
    const acro = acroOf(write([
      field({ id: 'a', name: 'one' }),
      field({ id: 'b', name: 'two', pageId: 'p1' }),
    ], 'rotated', 2))
    expect(acro?.fields.sort()).toEqual(['one', 'two'])
  })

  /**
   * The reason ensureAcroForm is idempotent. A source document's own
   * AcroForm holds the fields the user is editing; replacing it would
   * silently destroy every one of them.
   */
  it('extends a document that already has a form rather than replacing it', () => {
    // Build a source that already carries a field.
    const src = mupdf.PDFDocument.openDocument(bytes('simple-text'), 'application/pdf') as mupdf.PDFDocument
    const page = src.loadPage(0)
    const acro = src.newDictionary()
    acro.put('Fields', src.newArray())
    acro.put('DA', src.newString('/Helv 0 Tf 0 g'))
    const helv = src.newDictionary()
    helv.put('Type', src.newName('Font')); helv.put('Subtype', src.newName('Type1'))
    helv.put('BaseFont', src.newName('Helvetica'))
    const fonts = src.newDictionary(); fonts.put('Helv', src.addObject(helv))
    const dr = src.newDictionary(); dr.put('Font', fonts); acro.put('DR', dr)
    const acroRef = src.addObject(acro)
    src.getTrailer().get('Root').put('AcroForm', acroRef)

    const existing = src.newDictionary()
    existing.put('Type', src.newName('Annot')); existing.put('Subtype', src.newName('Widget'))
    existing.put('FT', src.newName('Tx')); existing.put('T', src.newString('theirs'))
    existing.put('DA', src.newString('/Helv 12 Tf 0 g')); existing.put('F', 4)
    const r = src.newArray(); for (const n of [50, 700, 250, 725]) r.push(n)
    existing.put('Rect', r)
    const eRef = src.addObject(existing)
    acroRef.get('Fields').push(eRef)
    const annots = src.newArray(); annots.push(eRef)
    page.getObject().put('Annots', annots)
    page.destroy()
    const withForm = src.saveToBuffer('compress').asUint8Array()
    src.destroy()

    const out = replay(new Map([['src-0', withForm]]), docWith([field({ name: 'ours' })]))
    expect(acroOf(out)?.fields.sort()).toEqual(['ours', 'theirs'])
    expect(widgetsOf(out).map((w) => w.name).sort()).toEqual(['ours', 'theirs'])
  })
})

/**
 * Geometry. A field written in the wrong space lands correctly on an
 * unrotated letter page and nowhere near right on any other, which is to
 * say not on the fixture anyone tests with first.
 */
describe('field geometry', () => {
  const RECT = { x: 60, y: 60, w: 120, h: 24 }
  const inside = (b: number[], page: number[]) =>
    b[0]! >= page[0]! - 1 && b[1]! >= page[1]! - 1 && b[2]! <= page[2]! + 1 && b[3]! <= page[3]! + 1

  it('lands exactly where Convention A says it should, on every rotation', () => {
    // rotated.pdf carries /Rotate 0, 90, 180, 270 on pages 0-3.
    const out = write(
      [0, 1, 2, 3].map((i) => field({ id: `f${i}`, pageId: `p${i}`, name: `f${i}`, rect: RECT })),
      'rotated', 4,
    )
    for (const i of [0, 1, 2, 3]) {
      const w = widgetsOf(out, i)
      expect(w, `page ${i}`).toHaveLength(1)
      const want = expectedBounds(out, RECT, i)
      w[0]!.bounds.forEach((v, k) => expect(v, `page ${i} component ${k}`).toBeCloseTo(want[k]!, 0))
      expect(inside(w[0]!.bounds, pageBounds(out, i)), `page ${i}`).toBe(true)
    }
  })

  /**
   * A rect is in RAW user space, so on a page whose CropBox does not start
   * at the origin it is not automatically inside the visible box -- (40,40)
   * on offset-cropbox.pdf is genuinely off-page, which findings 12 4
   * measured as getBounds [-40,455,60,480]. So this asserts exactness, and
   * places a second field RELATIVE to the CropBox origin to show that a
   * rect the app would actually produce lands where it should.
   */
  it('lands exactly right on an offset CropBox', () => {
    const rect = { x: 40, y: 40, w: 100, h: 24 }
    const out = write([field({ rect })], 'offset-cropbox')
    const want = expectedBounds(out, rect)
    widgetsOf(out)[0]!.bounds.forEach((v, k) => expect(v).toBeCloseTo(want[k]!, 0))
  })

  it('lands inside the visible box when placed relative to the CropBox', () => {
    const src = bytes('offset-cropbox')
    const doc = mupdf.PDFDocument.openDocument(src, 'application/pdf') as mupdf.PDFDocument
    const p = doc.loadPage(0)
    const [ox, oy] = geometryFromPageObject(p.getObject()).cropBox
    p.destroy(); doc.destroy()

    const rect = { x: ox + 20, y: oy + 20, w: 100, h: 24 }
    const out = replay(new Map([['src-0', src]]), docWith([field({ rect })]))
    const b = widgetsOf(out)[0]!.bounds
    expect(inside(b, pageBounds(out)), `bounds ${b}`).toBe(true)
    const want = expectedBounds(out, rect)
    b.forEach((v, k) => expect(v).toBeCloseTo(want[k]!, 0))
  })

  /**
   * The bug this suite caught, kept as its own case.
   *
   * Sending Convention A into a raw /Rect puts a field meant for the
   * bottom of a page at its top. On an unrotated page that is still
   * inside the page box, so it looks fine to anything that only checks
   * containment -- and three of the four rotations above agreed. Pin the
   * y explicitly: a rect 60pt from the BOTTOM of a 792pt page reads back
   * from getBounds() at 792-84=708.
   */
  it('puts a field near the bottom of the page near the bottom', () => {
    const out = write([field({ rect: RECT })])
    const [, y0, , y1] = widgetsOf(out)[0]!.bounds
    expect(y0).toBeCloseTo(708, 0)
    expect(y1).toBeCloseTo(732, 0)
  })
})
