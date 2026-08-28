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

/**
 * A dragged patch.
 *
 * Its `rect` stays on the line it replaces -- that is what the cover is
 * drawn from, and the cover does not move. So every surface that asks
 * "where is this object on screen" has to add the offset itself, or the
 * selection box, the layers list and the floating toolbar all stay pinned
 * to the original line while the text the user is looking at is elsewhere.
 */
describe('objectViewRect for a moved text patch', () => {
  const moved = (offset: { dx: number; dy: number }): EditObject =>
    obj({ kind: 'textPatch', offset })

  it('follows the text, not the cover', () => {
    expect(objectViewRect(moved({ dx: 15, dy: 25 }), LETTER, 1))
      .toEqual({ x: 115, y: 65, w: 80, h: 10 })
  })

  it('scales the offset by zoom, like everything else in view space', () => {
    expect(objectViewRect(moved({ dx: 15, dy: 25 }), LETTER, 2))
      .toEqual({ x: 230, y: 130, w: 160, h: 20 })
  })

  it('leaves an unmoved patch exactly where it was', () => {
    expect(objectViewRect(obj({ kind: 'textPatch' }), LETTER, 1))
      .toEqual(objectViewRect(moved({ dx: 0, dy: 0 }), LETTER, 1))
  })

  /** An offset on any other kind is meaningless and must not be read. */
  it('ignores an offset on a kind that does not have one', () => {
    expect(objectViewRect(obj({ kind: 'image', offset: { dx: 15, dy: 25 } }), LETTER, 1))
      .toEqual(objectViewRect(obj({ kind: 'image' }), LETTER, 1))
  })
})

/**
 * A resized copy has a size of its own, and the selection box, the layers
 * list and the floating toolbar all ask this function where it is. Reading
 * the rect's size would draw the box around the AREA COVERED instead --
 * which after a resize is a different rectangle entirely.
 */
describe('objectViewRect for a resized image patch', () => {
  const patch = (extra: Record<string, unknown> = {}): EditObject =>
    obj({ kind: 'imagePatch', data: new Uint8Array([1]), ...extra })

  it('uses the copy’s own size', () => {
    expect(objectViewRect(patch({ size: { w: 200, h: 50 } }), LETTER, 1))
      .toEqual({ x: 100, y: 40, w: 200, h: 50 })
  })

  it('combines a resize with a move', () => {
    expect(objectViewRect(
      patch({ size: { w: 200, h: 50 }, offset: { dx: 10, dy: 20 } }), LETTER, 1,
    )).toEqual({ x: 110, y: 60, w: 200, h: 50 })
  })

  it('scales the size by zoom', () => {
    expect(objectViewRect(patch({ size: { w: 200, h: 50 } }), LETTER, 2))
      .toEqual({ x: 200, y: 80, w: 400, h: 100 })
  })

  it('falls back to the covered area when there is no size', () => {
    expect(objectViewRect(patch(), LETTER, 1)).toEqual({ x: 100, y: 40, w: 80, h: 10 })
  })

  it('applies to a lifted area too', () => {
    expect(objectViewRect(
      obj({ kind: 'regionPatch', data: new Uint8Array([1]), size: { w: 30, h: 30 } }), LETTER, 1,
    )).toEqual({ x: 100, y: 40, w: 30, h: 30 })
  })

  /** A size on a kind that has none is meaningless and must not be read. */
  it('ignores a size on a kind that does not have one', () => {
    expect(objectViewRect(obj({ kind: 'image', size: { w: 500, h: 500 } }), LETTER, 1))
      .toEqual(objectViewRect(obj({ kind: 'image' }), LETTER, 1))
  })
})
