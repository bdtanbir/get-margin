import { describe, it, expect } from 'vitest'
import { familiesUsed } from '@/lib/fonts'
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
describe('familiesUsed', () => {
  it('collects a text object’s font', () => {
    expect(familiesUsed([object({ kind: 'text', fontFamily: 'Inter' })])).toEqual(['Inter'])
  })

  it('collects a stamp’s font — the kind that broke Download', () => {
    expect(familiesUsed([object({ kind: 'stamp', fontFamily: 'Inter' })])).toEqual(['Inter'])
  })

  it('collects a text patch’s font', () => {
    expect(familiesUsed([object({ kind: 'textPatch', fontFamily: 'Roboto' })])).toEqual(['Roboto'])
  })

  /**
   * Form fields deliberately have NO fontFamily: they use Helvetica, one
   * of the standard 14, which needs no embedding. So they contribute
   * nothing here, and that is correct rather than an omission.
   */
  it('asks for nothing on behalf of a form field', () => {
    expect(familiesUsed([object({ kind: 'field' })])).toEqual([])
  })

  it('reports each family once', () => {
    expect(familiesUsed([
      object({ kind: 'text', fontFamily: 'Inter' }),
      object({ kind: 'stamp', fontFamily: 'Inter' }),
    ])).toEqual(['Inter'])
  })

  it('collects several families', () => {
    expect(familiesUsed([
      object({ kind: 'text', fontFamily: 'Inter' }),
      object({ kind: 'stamp', fontFamily: 'Merriweather' }),
    ]).sort()).toEqual(['Inter', 'Merriweather'])
  })

  it('ignores kinds with no font', () => {
    expect(familiesUsed([
      object({ kind: 'rect' }),
      object({ kind: 'ink' }),
      object({ kind: 'redaction' }),
    ])).toEqual([])
  })

  it('ignores an empty family rather than asking for a font called ""', () => {
    expect(familiesUsed([object({ kind: 'text', fontFamily: '' })])).toEqual([])
  })

  it('handles no objects', () => {
    expect(familiesUsed([])).toEqual([])
  })
})
