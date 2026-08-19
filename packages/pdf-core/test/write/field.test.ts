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

/** /AS, /V, and the /AP /N state keys — read raw, because the API hides them. */
function buttonStates(pdf: Uint8Array, page = 0) {
  const doc = mupdf.PDFDocument.openDocument(pdf, 'application/pdf') as mupdf.PDFDocument
  const p = doc.loadPage(page)
  try {
    const out: Array<{ as: string; apStates: string[]; hasBorder: boolean; parentV: string | null }> = []
    p.getObject().get('Annots').forEach((a) => {
      if (a.get('Subtype').asName() !== 'Widget') return
      const states: string[] = []
      // Not every widget has an /AP -- a signature field has none, and a
      // text field's is generated by the viewer.
      const ap = a.get('AP')
      if (ap.isDictionary()) {
        const n = ap.get('N')
        if (n.isDictionary()) n.forEach((_v, k) => states.push(String(k)))
      }
      const parent = a.get('Parent')
      out.push({
        as: a.get('AS').isName() ? a.get('AS').asName() : '',
        apStates: states.sort(),
        hasBorder: !a.get('MK').get('BC').isNull(),
        parentV: parent.isDictionary() && parent.get('V').isName() ? parent.get('V').asName() : null,
      })
    })
    return out
  } finally { p.destroy(); doc.destroy() }
}

/** The /AcroForm /Fields entries, with their kid counts. */
function formFields(pdf: Uint8Array) {
  const doc = mupdf.PDFDocument.openDocument(pdf, 'application/pdf') as mupdf.PDFDocument
  try {
    const out: Array<{ name: string; kids: number; flags: number }> = []
    doc.getTrailer().get('Root').get('AcroForm').get('Fields').forEach((f) => {
      out.push({
        name: f.get('T').asString(),
        kids: f.get('Kids').isArray() ? f.get('Kids').length : 0,
        flags: f.get('Ff').isNull() ? 0 : f.get('Ff').asNumber(),
      })
    })
    return out
  } finally { doc.destroy() }
}

describe('checkbox writer', () => {
  const box = (over = {}) =>
    field({ fieldType: 'checkbox', name: 'agree', rect: { x: 100, y: 400, w: 18, h: 18 }, ...over })

  it('round-trips checked and unchecked', () => {
    expect(buttonStates(write([box({ value: true })]))[0]!.as).toBe('Yes')
    expect(buttonStates(write([box({ value: false })]))[0]!.as).toBe('Off')
  })

  it('reports as a checkbox after reopen', () => {
    expect(widgetsOf(write([box()]))[0]!.type).toBe('checkbox')
  })

  it('carries both appearance states', () => {
    expect(buttonStates(write([box()]))[0]!.apStates).toEqual(['Off', 'Yes'])
  })

  // Phase 0's finding: without /MK /BC the unchecked state renders
  // invisibly, which looks like a missing field rather than an empty one.
  it('carries a border, so unchecked is visible', () => {
    expect(buttonStates(write([box()]))[0]!.hasBorder).toBe(true)
  })
})

/**
 * The reason PLAN.md required a spike before this phase was estimated.
 * findings 12 1 measured what the spec's inference produced: three buttons
 * that were one button.
 */
describe('radio group writer', () => {
  const radios = (selected: number | null) =>
    ['alpha', 'beta', 'gamma'].map((state, i) => field({
      id: `r${i}`, fieldType: 'radio', name: 'choice', group: 'choice',
      exportValue: state, value: selected === i,
      rect: { x: 100, y: 400 - i * 30, w: 18, h: 18 },
    }))

  it('makes one parent field with three kids, not three fields', () => {
    const f = formFields(write(radios(1)))
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ name: 'choice', kids: 3 })
  })

  it('sets the radio and no-toggle-off flags on the parent', () => {
    const flags = formFields(write(radios(0)))[0]!.flags
    expect(flags & 32768).toBe(32768)
    expect(flags & 16384).toBe(16384)
  })

  /**
   * THE FINDING. Each kid's /AP /N must be keyed by its OWN export value:
   * mupdf derives the button's on-state name from those keys, so two kids
   * sharing one are the same button.
   */
  it('gives every button its own on-state name', () => {
    const states = buttonStates(write(radios(null))).map((b) => b.apStates)
    expect(states).toEqual([['Off', 'alpha'], ['Off', 'beta'], ['Off', 'gamma']])
  })

  /**
   * Asserted on /AS, never getValue() -- findings 12 3: a kid's getValue()
   * returns the GROUP's value, so all three would report "beta" and a
   * getValue-based assertion would pass for a document where every button
   * was on.
   */
  it('selects exactly one button', () => {
    const b = buttonStates(write(radios(1)))
    expect(b.map((x) => x.as)).toEqual(['Off', 'beta', 'Off'])
    expect(b.every((x) => x.parentV === 'beta')).toBe(true)
  })

  it('selects none when none is chosen', () => {
    expect(buttonStates(write(radios(null))).map((b) => b.as)).toEqual(['Off', 'Off', 'Off'])
  })

  // Exclusion has to survive the round trip, not just the write.
  it('keeps exclusion through save and reopen', () => {
    const once = write(radios(2))
    const twice = replay(new Map([['src-0', once]]), docWith([]))
    expect(buttonStates(twice).map((b) => b.as)).toEqual(['Off', 'Off', 'gamma'])
  })

  it('reports every button as a radio button', () => {
    expect(widgetsOf(write(radios(0))).map((w) => w.type)).toEqual(
      ['radiobutton', 'radiobutton', 'radiobutton'],
    )
  })

  it('spreads one group across pages', () => {
    const out = write([
      field({ id: 'a', fieldType: 'radio', name: 'q', group: 'q', exportValue: 'yes', value: true,
        rect: { x: 60, y: 400, w: 18, h: 18 } }),
      field({ id: 'b', fieldType: 'radio', name: 'q', group: 'q', exportValue: 'no', pageId: 'p1',
        rect: { x: 60, y: 400, w: 18, h: 18 } }),
    ], 'rotated', 2)
    expect(formFields(out)).toHaveLength(1)
    expect(formFields(out)[0]!.kids).toBe(2)
    expect(buttonStates(out, 0)[0]!.as).toBe('yes')
    expect(buttonStates(out, 1)[0]!.as).toBe('Off')
  })

  // "Off" is the universal unselected state; a button claiming it as its
  // ON state can never be told apart from being off.
  it('refuses "Off" as an export value', () => {
    expect(() => write([field({
      fieldType: 'radio', name: 'q', group: 'q', exportValue: 'Off',
      rect: { x: 60, y: 400, w: 18, h: 18 },
    })])).toThrow(/Off/)
  })
})

describe('choice fields', () => {
  const choice = (over = {}) => field({
    fieldType: 'dropdown', name: 'country', options: ['Bangladesh', 'Canada', 'Denmark'],
    rect: { x: 100, y: 400, w: 160, h: 22 }, ...over,
  })

  it('round-trips its options in order', () => {
    expect(widgetsOf(write([choice()]))[0]!.options)
      .toEqual(['Bangladesh', 'Canada', 'Denmark'])
  })

  it('distinguishes a dropdown from a list box', () => {
    const combo = widgetsOf(write([choice()]))[0]!
    const list = widgetsOf(write([choice({ fieldType: 'listbox' })]))[0]!
    expect(combo.flags & (1 << 17)).toBe(1 << 17)
    expect(list.flags & (1 << 17)).toBe(0)
    expect(combo.type).toBe('combobox')
    expect(list.type).toBe('listbox')
  })

  it('keeps a selected value', () => {
    expect(widgetsOf(write([choice({ value: 'Canada' })]))[0]!.value).toBe('Canada')
  })

  // A value outside the options is a field no viewer can display
  // consistently, so it is dropped rather than written.
  it('drops a value that is not one of the options', () => {
    expect(widgetsOf(write([choice({ value: 'Atlantis' })]))[0]!.value).toBe('')
  })
})

describe('signature field', () => {
  const sig = (over = {}) => field({
    fieldType: 'signature', name: 'sign_here',
    rect: { x: 100, y: 300, w: 200, h: 50 }, ...over,
  })

  it('is a place for a signature, holding none', () => {
    const w = widgetsOf(write([sig()]))[0]!
    expect(w.type).toBe('signature')
    expect(w.value).toBe('')
  })

  it('is visible when empty', () => {
    expect(buttonStates(write([sig()]))[0]!.hasBorder).toBe(true)
  })
})
