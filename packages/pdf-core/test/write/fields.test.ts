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

/**
 * Filling fields the source document already had.
 *
 * Every fixture here is built by exporting a document WITH fields and then
 * treating that output as the source, which is the same shape as a user
 * opening a form somebody sent them.
 */
describe('applyFieldValues', () => {
  const formDoc = () => build([
    field({ id: 'a', name: 'fullname' }),
    field({ id: 'b', name: 'agree', fieldType: 'checkbox', rect: { x: 100, y: 350, w: 18, h: 18 } }),
    field({ id: 'c', name: 'country', fieldType: 'dropdown', options: ['BD', 'CA'],
      rect: { x: 100, y: 300, w: 160, h: 22 } }),
  ])

  const fill = (values: Record<string, string | boolean | string[]>, src = formDoc()) =>
    replay(new Map([['src-0', src]]), { ...docWith([]), fieldValues: values })

  it('puts a typed value into the exported field', () => {
    const out = fill({ fullname: 'Ada Lovelace' })
    expect(fieldsOf(out).find((f) => f.name === 'fullname')!.value).toBe('Ada Lovelace')
  })

  it('puts the value in the exported bytes, not just the object model', () => {
    expect(Buffer.from(fill({ fullname: 'Ada Lovelace' })).includes('Ada Lovelace')).toBe(true)
  })

  it('checks and unchecks a checkbox', () => {
    expect(fieldsOf(fill({ agree: true })).find((f) => f.name === 'agree')!.state).toBe('Yes')
    expect(fieldsOf(fill({ agree: false })).find((f) => f.name === 'agree')!.state).toBe('Off')
  })

  it('selects a choice option', () => {
    expect(fieldsOf(fill({ country: 'CA' })).find((f) => f.name === 'country')!.value).toBe('CA')
  })

  it('leaves fields it was given no value for alone', () => {
    const out = fill({ fullname: 'Ada' })
    expect(fieldsOf(out).find((f) => f.name === 'country')!.value).toBe('')
  })

  /**
   * A key matching nothing means the page carrying that field was deleted
   * after it was filled -- an ordinary sequence of edits. Throwing would
   * make an undo the user already performed block their download.
   */
  it('ignores a value whose field is gone', () => {
    expect(() => fill({ fullname: 'Ada', deleted_field: 'x' })).not.toThrow()
    expect(fieldsOf(fill({ deleted_field: 'x' })).find((f) => f.name === 'fullname')!.value).toBe('')
  })

  it('does not disturb the rest of the document', () => {
    const before = fieldsOf(formDoc()).length
    expect(fieldsOf(fill({ fullname: 'Ada' })).length).toBe(before)
  })

  // A user who types into a form and downloads must not get their original
  // file back -- the pass-through tier would silently discard the only
  // thing they did.
  it('defeats the byte-identical pass-through', () => {
    const src = formDoc()
    expect(Buffer.from(fill({ fullname: 'Ada' }, src)).equals(Buffer.from(src))).toBe(false)
  })

  it('still hands back an untouched form byte for byte', () => {
    const src = formDoc()
    const out = replay(new Map([['src-0', src]]), docWith([]))
    expect(Buffer.from(out).equals(Buffer.from(src))).toBe(true)
  })

  it('selects one button of a radio group by its export value', () => {
    const src = build(['alpha', 'beta'].map((state, i) => field({
      id: `r${i}`, fieldType: 'radio', name: 'choice', group: 'choice', exportValue: state,
      rect: { x: 100, y: 400 - i * 30, w: 18, h: 18 },
    })))
    const out = fill({ choice: 'beta' }, src)
    expect(fieldsOf(out).map((f) => f.state)).toEqual(['Off', 'beta'])
  })
})

describe('flattenForms', () => {
  const withInkAndField = () => build([
    field({ name: 'fullname', value: 'Ada Lovelace' }),
    { id: 'i1', pageId: 'p0', kind: 'ink', strokes: [[100, 100, 200, 150]],
      color: [0, 0, 0], strokeWidth: 2,
      rect: { x: 100, y: 100, w: 100, h: 50 }, rotation: 0, z: 2, locked: false, opacity: 1 },
  ])

  const flatten = (src: Uint8Array) =>
    replay(new Map([['src-0', src]]), { ...docWith([]), flattenForms: true })

  const annotCounts = (pdf: Uint8Array) => {
    const doc = mupdf.PDFDocument.openDocument(pdf, 'application/pdf') as mupdf.PDFDocument
    const p = doc.loadPage(0)
    try {
      return {
        widgets: p.getWidgets().length,
        annots: p.getAnnotations().length,
        text: p.toStructuredText().asText(),
        acroForm: !doc.getTrailer().get('Root').get('AcroForm').isNull(),
      }
    } finally { p.destroy(); doc.destroy() }
  }

  it('is off by default', () => {
    expect(annotCounts(withInkAndField()).widgets).toBe(1)
  })

  it('removes the fields and keeps their values in the page', () => {
    const out = annotCounts(flatten(withInkAndField()))
    expect(out.widgets).toBe(0)
    expect(out.text).toContain('Ada Lovelace')
    expect(out.acroForm).toBe(false)
  })

  /**
   * The semantic split, held. bake(false, true) is chosen over
   * bake(true, true) precisely so ink and markup stay editable in other
   * PDF tools -- flattening a form is not a reason to destroy a signature.
   */
  it('leaves ink annotations editable', () => {
    expect(annotCounts(flatten(withInkAndField())).annots).toBe(1)
  })

  it('defeats the byte-identical pass-through', () => {
    const src = withInkAndField()
    expect(Buffer.from(flatten(src)).equals(Buffer.from(src))).toBe(false)
  })
})

/**
 * Radio fill, on its own, because it is the one case where the value is
 * the GROUP's and each button has to decide whether it is the one named.
 */
describe('applyFieldValues on a radio group', () => {
  const src = () => build(['alpha', 'beta', 'gamma'].map((state, i) => field({
    id: `r${i}`, fieldType: 'radio', name: 'choice', group: 'choice', exportValue: state,
    rect: { x: 100, y: 400 - i * 30, w: 18, h: 18 },
  })))
  const fill = (v: string) =>
    fieldsOf(replay(new Map([['src-0', src()]]), { ...docWith([]), fieldValues: { choice: v } }))

  it('turns on exactly the named button', () => {
    expect(fill('gamma').map((f) => f.state)).toEqual(['Off', 'Off', 'gamma'])
  })

  // Treating the group's value as "this button is on" -- which is what a
  // checkbox does -- turns on EVERY button, because they all see the same
  // string and all say yes.
  it('turns on exactly one, not all of them', () => {
    expect(fill('alpha').filter((f) => f.state !== 'Off')).toHaveLength(1)
  })

  it('turns them all off for an empty value', () => {
    expect(fill('').map((f) => f.state)).toEqual(['Off', 'Off', 'Off'])
  })

  it('turns them all off for a value naming no button', () => {
    expect(fill('delta').map((f) => f.state)).toEqual(['Off', 'Off', 'Off'])
  })

  it('reports the group value on every button, as the format requires', () => {
    expect(fill('beta').map((f) => f.value)).toEqual(['beta', 'beta', 'beta'])
  })
})
