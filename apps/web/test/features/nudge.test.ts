import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { nudgeOpFor } from '@/features/overlay/nudge'
import { objectViewRect } from '@/features/overlay/objectViewRect'
import { useEditsStore } from '@/stores/edits'
import type { PageGeometry } from '@margin/transform'
import type { EditObject } from '@margin/pdf-core'

const PAGE: PageGeometry = { cropBox: [0, 0, 612, 792], rotate: 0 }

function rect(over: Record<string, unknown> = {}): EditObject {
  return {
    id: 'o1', pageId: 'p1', kind: 'rect',
    rect: { x: 100, y: 200, w: 80, h: 40 },
    rotation: 0, z: 1, locked: false, opacity: 1,
    stroke: [0, 0, 0], strokeWidth: 1, fill: null,
    ...over,
  } as EditObject
}

/** A patched line at page-space 40,100, already dragged if `offset` says so. */
function textPatch(over: Record<string, unknown> = {}): EditObject {
  return {
    id: 'o1', pageId: 'p1', kind: 'textPatch',
    lineIndex: 0, originalHash: 'h', originalText: 'Alpha', text: 'Alpha',
    fontFamily: 'Inter', bold: false, italic: false, fontSize: 12, baseline: 114,
    color: [0, 0, 0], background: [1, 1, 1], backgroundConfidence: 1, fit: 'overflow',
    rect: { x: 40, y: 100, w: 50, h: 18 },
    rotation: 0, z: 1, locked: false, opacity: 1,
    ...over,
  } as EditObject
}

function imagePatch(over: Record<string, unknown> = {}): EditObject {
  return {
    id: 'o1', pageId: 'p1', kind: 'imagePatch',
    imageIndex: 0, originalHash: 'aaaa1111',
    background: [1, 1, 1], backgroundConfidence: 1,
    rect: { x: 50, y: 50, w: 200, h: 100 },
    rotation: 0, z: 1, locked: false, opacity: 1,
    ...over,
  } as EditObject
}

/** Apply a nudge through the real store, and hand back what it became. */
function nudged(
  o: EditObject,
  step: { dx: number; dy: number },
  g: PageGeometry = PAGE,
  zoom = 1,
): EditObject {
  const edits = useEditsStore()
  edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
    { p1: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null } })
  edits.applyOp({ type: 'addObject', object: o }, 'add')
  const op = nudgeOpFor(o, step, g, zoom)
  expect(op, 'no op produced').toBeDefined()
  edits.applyOp(op!, 'Move')
  return edits.doc.objects[o.id]!
}

describe('nudgeOpFor', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('moves an object by the step, in points', () => {
    expect(nudged(rect(), { dx: 1, dy: 0 }).rect.x).toBe(101)
  })

  /**
   * Up on screen is up the PAGE, and a PDF counts y from the bottom -- so a
   * step the user reads as "up" has to ADD to the stored y. Getting this
   * backwards is the classic version of this bug: the object walks away
   * from the arrow being pressed.
   */
  it('sends the object up the page when the step is up the screen', () => {
    expect(nudged(rect(), { dx: 0, dy: -1 }).rect.y).toBe(201)
  })

  it('moves the same distance however far the document is zoomed', () => {
    const near = nudged(rect(), { dx: 3, dy: -2 }, PAGE, 1).rect
    const far = nudged(rect(), { dx: 3, dy: -2 }, PAGE, 4).rect
    // A nudge is a document distance, not a screen distance: 1pt at 400%
    // is the same 1pt it is at 100%, so the object does not accelerate as
    // you zoom in.
    expect(far).toEqual(near)
  })

  /**
   * On a quarter-turned page the arrow the user presses and the axis the
   * rect is stored on are no longer the same axis. Asserted through
   * `objectViewRect` -- where the thing actually IS on screen -- rather
   * than against hand-derived stored coordinates, because that is the claim
   * the user can see: press right, it goes right.
   */
  it.each([0, 90, 180, 270] as const)('follows the arrow on a page turned %i°', (rotate) => {
    const g: PageGeometry = { cropBox: [0, 0, 612, 792], rotate }
    const before = objectViewRect(rect(), g, 1)
    const after = objectViewRect(nudged(rect(), { dx: 2, dy: -3 }, g, 1), g, 1)
    expect(after.x).toBeCloseTo(before.x + 2, 6)
    expect(after.y).toBeCloseTo(before.y - 3, 6)
  })

  /**
   * A patch moves the REPLACEMENT and leaves the cover where the document's
   * own glyphs are -- exactly what dragging one does. Rewriting the rect
   * would slide the cover off the original text, which would then reappear
   * from underneath.
   */
  it('moves a text patch by its offset, leaving the cover it paints alone', () => {
    const after = nudged(textPatch(), { dx: 0, dy: -1 })
    expect(after.kind === 'textPatch' && after.offset).toEqual({ dx: 0, dy: -1 })
    expect(after.rect).toEqual({ x: 40, y: 100, w: 50, h: 18 })
  })

  it('accumulates onto an offset a patch already has', () => {
    const after = nudged(textPatch({ offset: { dx: 5, dy: 5 } }), { dx: 1, dy: 1 })
    expect(after.kind === 'textPatch' && after.offset).toEqual({ dx: 6, dy: 6 })
  })

  it('moves an image patch the same way', () => {
    const after = nudged(imagePatch({ offset: { dx: 2, dy: 0 } }), { dx: 10, dy: 0 })
    expect(after.kind === 'imagePatch' && after.offset).toEqual({ dx: 12, dy: 0 })
    expect(after.rect).toEqual({ x: 50, y: 50, w: 200, h: 100 })
  })

  /**
   * Page space runs top-down, unlike the rect above: a patch dragged up the
   * screen gets a SMALLER dy, and one nudged up must too, or a line moves
   * one way with the mouse and the other with the keyboard.
   */
  it('agrees with the mouse about which way is up', () => {
    const after = nudged(textPatch({ offset: { dx: 0, dy: 4 } }), { dx: 0, dy: -1 })
    expect(after.kind === 'textPatch' && after.offset).toEqual({ dx: 0, dy: 3 })
  })

  it('refuses to move a locked object', () => {
    expect(nudgeOpFor(rect({ locked: true }), { dx: 1, dy: 0 }, PAGE, 1)).toBeUndefined()
  })
})
