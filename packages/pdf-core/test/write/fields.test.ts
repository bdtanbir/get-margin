import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import * as mupdf from 'mupdf'
import { replay } from '../../src/write/index.js'
import { listFields, fieldKey } from '../../src/write/fields.js'
import { emptyEditDocument, type EditDocument, type EditObject, type FieldObject } from '../../src/write/types.js'
import { generateFixtures, fixturePath, type FixtureName } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: FixtureName): Uint8Array => new Uint8Array(readFileSync(fixturePath(n)))

function field(over: Partial<FieldObject> = {}): FieldObject {
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

function docWith(objects: EditObject[]): EditDocument {
  return {
    ...emptyEditDocument(),
    sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: ['p0'],
    pages: { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    nextZ: 99,
  }
}

/** Build a document carrying fields, then read them back the way the app will. */
function fieldsOf(pdf: Uint8Array, page = 0, ref = 'src-0:0') {
  const doc = mupdf.PDFDocument.openDocument(pdf, 'application/pdf') as mupdf.PDFDocument
  try { return listFields(doc, page, ref) } finally { doc.destroy() }
}

const build = (objects: EditObject[], fixture: FixtureName = 'simple-text') =>
  replay(new Map([['src-0', bytes(fixture)]]), docWith(objects))

describe('listFields', () => {
  it('returns nothing for a document with no form', () => {
    expect(fieldsOf(bytes('simple-text'))).toEqual([])
  })

  it('reports each field with its type and name', () => {
    const out = build([
      field({ id: 'a', name: 'fullname' }),
      field({ id: 'b', name: 'agree', fieldType: 'checkbox', rect: { x: 100, y: 350, w: 18, h: 18 } }),
      field({ id: 'c', name: 'country', fieldType: 'dropdown', options: ['BD', 'CA'],
        rect: { x: 100, y: 300, w: 160, h: 22 } }),
      field({ id: 'd', name: 'sign', fieldType: 'signature', rect: { x: 100, y: 200, w: 200, h: 50 } }),
    ])
    const by = Object.fromEntries(fieldsOf(out).map((f) => [f.name, f]))
    expect(by.fullname!.type).toBe('text')
    expect(by.agree!.type).toBe('checkbox')
    expect(by.country!.type).toBe('dropdown')
    expect(by.country!.options).toEqual(['BD', 'CA'])
    expect(by.sign!.type).toBe('signature')
  })

  it('reports properties the overlay needs to render a control', () => {
    const out = build([
      field({ id: 'a', name: 'notes', multiline: true, maxLength: 200 }),
      field({ id: 'b', name: 'locked', readOnly: true, rect: { x: 100, y: 300, w: 200, h: 24 } }),
      field({ id: 'c', name: 'must', required: true, rect: { x: 100, y: 200, w: 200, h: 24 } }),
    ])
    const by = Object.fromEntries(fieldsOf(out).map((f) => [f.name, f]))
    expect(by.notes!.multiline).toBe(true)
    expect(by.notes!.maxLength).toBe(200)
    expect(by.locked!.readOnly).toBe(true)
    expect(by.must!.required).toBe(true)
    expect(by.notes!.readOnly).toBe(false)
  })

  /**
   * The rect is Convention A and goes to the overlay unconverted, so this
   * pins it against the same getBounds the renderer's transform assumes.
   * A field 400pt up a 792pt page is 792-424=368 from the top.
   */
  it('reports the rect in the renderer’s space', () => {
    const out = build([field({ rect: { x: 100, y: 400, w: 200, h: 24 } })])
    const r = fieldsOf(out)[0]!.rect
    expect(r.x).toBeCloseTo(100, 0)
    expect(r.y).toBeCloseTo(368, 0)
    expect(r.w).toBeCloseTo(200, 0)
    expect(r.h).toBeCloseTo(24, 0)
  })

  it('reports a value the document shipped with', () => {
    expect(fieldsOf(build([field({ value: 'Ada' })]))[0]!.value).toBe('Ada')
  })
})

/**
 * THE FINDING THAT FAILS QUIETLY. A radio kid's getValue() returns the
 * GROUP's value, so every button in a group reports the selected option --
 * and a UI that renders "checked" from it shows every option as chosen.
 */
describe('listFields on a radio group', () => {
  const out = () => build(['alpha', 'beta', 'gamma'].map((state, i) => field({
    id: `r${i}`, fieldType: 'radio', name: 'choice', group: 'choice',
    exportValue: state, value: i === 1,
    rect: { x: 100, y: 400 - i * 30, w: 18, h: 18 },
  })))

  it('reports the group value on every button, which is why state exists', () => {
    expect(fieldsOf(out()).map((f) => f.value)).toEqual(['beta', 'beta', 'beta'])
  })

  it('reports each button’s own state, so exactly one reads as selected', () => {
    const f = fieldsOf(out())
    expect(f.map((x) => x.state)).toEqual(['Off', 'beta', 'Off'])
    expect(f.filter((x) => x.state !== 'Off')).toHaveLength(1)
  })

  it('reports each button’s export value', () => {
    expect(fieldsOf(out()).map((f) => f.exportValue)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('gives every button in the group the same key, because they are one field', () => {
    expect(new Set(fieldsOf(out()).map((f) => f.key)).size).toBe(1)
  })

  it('reports no state for a field that is not a button', () => {
    expect(fieldsOf(build([field()]))[0]!.state).toBeNull()
  })
})

describe('fieldKey', () => {
  it('keys a named field by its name, so two widgets sharing a /T share a value', () => {
    expect(fieldKey('fullname', 'src-0:0', 0)).toBe('fullname')
    expect(fieldKey('fullname', 'src-0:4', 7)).toBe('fullname')
  })

  it('keys an unnamed field off its source page and position', () => {
    expect(fieldKey('', 'src-0:3', 2)).toBe('#unnamed:src-0:3#2')
    expect(fieldKey('   ', 'src-0:3', 2)).toBe('#unnamed:src-0:3#2')
  })
})
