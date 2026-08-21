import { describe, it, expect } from 'vitest'
import { objectViewRect } from '@/features/overlay/objectViewRect'
import { LETTER } from '../helpers/seedDocument'
import type { EditObject } from '@margin/pdf-core'

const base = {
  id: 'o1', pageId: 'p1', rotation: 0, z: 1, locked: false, opacity: 1,
  rect: { x: 100, y: 40, w: 80, h: 10 },
}
const obj = (extra: Record<string, unknown>): EditObject => ({ ...base, ...extra }) as EditObject

describe('objectViewRect', () => {
  it('flips a normal object, whose rect is bottom-up PDF space', () => {
    expect(objectViewRect(obj({ kind: 'image' }), LETTER, 1))
      .toEqual({ x: 100, y: 792 - 40 - 10, w: 80, h: 10 })
  })

  /**
   * The bug this pins: a text patch's rect comes straight from the line's
   * character quads, which are MuPDF PAGE space (top-down). Read as PDF
   * space it lands at the mirror image of the line it replaces -- clicking
   * its layer took you to the top of the page for a line near the bottom.
   */
  it('does not flip a text patch, whose rect is already page space', () => {
    expect(objectViewRect(obj({ kind: 'textPatch' }), LETTER, 1))
      .toEqual({ x: 100, y: 40, w: 80, h: 10 })
  })

  // Markup rects are converted to PDF space when they are created (see
  // SelectionToolbar), precisely so they follow the same rule as everything
  // else. Only the patch is the exception.
  it('flips markup and redaction, whose rects are stored PDF-space', () => {
    expect(objectViewRect(obj({ kind: 'highlight' }), LETTER, 1).y).toBe(792 - 40 - 10)
    expect(objectViewRect(obj({ kind: 'redaction' }), LETTER, 1).y).toBe(792 - 40 - 10)
  })

  it('scales by zoom either way', () => {
    expect(objectViewRect(obj({ kind: 'textPatch' }), LETTER, 2).y).toBe(80)
    expect(objectViewRect(obj({ kind: 'image' }), LETTER, 2).y).toBe((792 - 50) * 2)
  })
})
