import { describe, it, expect } from 'vitest'
import { facesUsed } from '@/lib/fonts'
import type { EditObject } from '@margin/pdf-core'

const object = (over: Partial<EditObject> & { kind: string }): EditObject => ({
  id: 'o', pageId: 'p1', rect: { x: 0, y: 0, w: 10, h: 10 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  ...over,
} as EditObject)

/**
 * ONE place that knows which kinds carry a font.
 *
 * Five call sites each filtered on `kind === 'text'`, and Phase 6 added
 * three more kinds with a fontFamily. Every one of those sites silently
 * stopped supplying what the export needed: adding a watermark and
 * pressing Download failed with "font Inter was not provided", because
 * the collection did not know stamps had fonts.
 */
describe('facesUsed', () => {
  it('collects a text object’s font', () => {
    expect(facesUsed([object({ kind: 'text', fontFamily: 'Inter' })])).toEqual(['Inter'])
  })

  it('collects a stamp’s font — the kind that broke Download', () => {
    expect(facesUsed([object({ kind: 'stamp', fontFamily: 'Inter' })])).toEqual(['Inter'])
  })

  it('collects a text patch’s font', () => {
    expect(facesUsed([object({ kind: 'textPatch', fontFamily: 'Roboto' })])).toEqual(['Roboto'])
  })

  /**
   * Form fields deliberately have NO fontFamily: they use Helvetica, one
   * of the standard 14, which needs no embedding. So they contribute
   * nothing here, and that is correct rather than an omission.
   */
  it('asks for nothing on behalf of a form field', () => {
    expect(facesUsed([object({ kind: 'field' })])).toEqual([])
  })

  it('reports each family once', () => {
    expect(facesUsed([
      object({ kind: 'text', fontFamily: 'Inter' }),
      object({ kind: 'stamp', fontFamily: 'Inter' }),
    ])).toEqual(['Inter'])
  })

  it('collects several families', () => {
    expect(facesUsed([
      object({ kind: 'text', fontFamily: 'Inter' }),
      object({ kind: 'stamp', fontFamily: 'Merriweather' }),
    ]).sort()).toEqual(['Inter', 'Merriweather'])
  })

  it('ignores kinds with no font', () => {
    expect(facesUsed([
      object({ kind: 'rect' }),
      object({ kind: 'ink' }),
      object({ kind: 'redaction' }),
    ])).toEqual([])
  })

  it('ignores an empty family rather than asking for a font called ""', () => {
    expect(facesUsed([object({ kind: 'text', fontFamily: '' })])).toEqual([])
  })

  it('handles no objects', () => {
    expect(facesUsed([])).toEqual([])
  })

  /**
   * Weight is part of the address, not a decoration on it.
   *
   * Bold is a SEPARATE font file. A collector that returned bare families
   * would hand the export the regular for a bold heading, and the writer
   * would throw "font Inter Bold was not provided" at Download time --
   * the same class of failure the stamp case above records, one axis over.
   */
  it('asks for the bold face when an object is bold', () => {
    expect(facesUsed([object({ kind: 'text', fontFamily: 'Inter', bold: true })]))
      .toEqual(['Inter Bold'])
  })

  it('asks for both faces when a document mixes weights', () => {
    expect(facesUsed([
      object({ kind: 'text', fontFamily: 'Inter' }),
      object({ kind: 'text', fontFamily: 'Inter', bold: true }),
    ]).sort()).toEqual(['Inter', 'Inter Bold'])
  })

  it('treats an absent bold as regular, so a stored document needs no migration', () => {
    expect(facesUsed([object({ kind: 'textPatch', fontFamily: 'Inter' })])).toEqual(['Inter'])
  })
})
