import { describe, it, expect } from 'vitest'
import { layerLabel, LABEL_MAX } from '@/features/layers/layerLabel'
import type { EditObject } from '@margin/pdf-core'

const base = {
  id: 'o1', pageId: 'p1', rect: { x: 0, y: 0, w: 10, h: 10 },
  rotation: 0, z: 1, locked: false, opacity: 1,
}

const obj = (extra: Record<string, unknown>): EditObject =>
  ({ ...base, ...extra }) as EditObject

describe('layerLabel', () => {
  // A row that says "Text" for every text object is a list you have to
  // click through one by one. What the object SAYS is what identifies it.
  it('labels a text object with its own text', () => {
    expect(layerLabel(obj({ kind: 'text', text: 'custom text added' }))).toBe('custom text added')
  })

  it('truncates long text to a row-sized label', () => {
    const long = 'a'.repeat(LABEL_MAX + 20)
    const label = layerLabel(obj({ kind: 'text', text: long }))
    expect(label).toHaveLength(LABEL_MAX + 1)
    expect(label.endsWith('…')).toBe(true)
  })

  // Empty text is a real state -- a text object is created before anything
  // is typed into it -- and an empty row would be unclickable-looking.
  it('falls back to the kind name for empty text', () => {
    expect(layerLabel(obj({ kind: 'text', text: '   ' }))).toBe('Text')
  })

  it('collapses newlines so a multi-line object stays one row', () => {
    expect(layerLabel(obj({ kind: 'text', text: 'first\nsecond' }))).toBe('first second')
  })

  it('labels a stamp with its resolved text', () => {
    expect(layerLabel(obj({ kind: 'stamp', stampKind: 'watermark', text: 'DRAFT' }))).toBe('DRAFT')
  })

  it('labels a link with its target', () => {
    expect(layerLabel(obj({ kind: 'link', uri: 'https://example.com' }))).toBe('https://example.com')
  })

  it('labels a form field with its name', () => {
    expect(layerLabel(obj({ kind: 'field', fieldType: 'text', name: 'Full name' }))).toBe('Full name')
  })

  it('labels an edited line with its replacement text', () => {
    expect(layerLabel(obj({ kind: 'textPatch', text: 'now says this' }))).toBe('now says this')
  })

  it.each([
    ['image', 'Image'],
    ['signature', 'Signature'],
    ['rect', 'Rectangle'],
    ['ellipse', 'Ellipse'],
    ['line', 'Line'],
    ['arrow', 'Arrow'],
    ['ink', 'Drawing'],
    ['whiteout', 'Whiteout'],
    ['highlight', 'Highlight'],
    ['underline', 'Underline'],
    ['strikeout', 'Strikeout'],
    ['redaction', 'Redaction'],
  ])('labels a %s object "%s"', (kind, expected) => {
    expect(layerLabel(obj({ kind }))).toBe(expected)
  })
})
