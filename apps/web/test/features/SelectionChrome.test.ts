import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SelectionChrome from '@/features/overlay/SelectionChrome.vue'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import type { PageState } from '@/stores/document'
import type { EditObject } from '@margin/pdf-core'

const page: PageState = { id: 'p1', sourceId: 'src-0', sourceIndex: 0, geometry: { cropBox: [0, 0, 612, 792], rotate: 0 } }

const object: EditObject = {
  id: 'o1', pageId: 'p1', kind: 'rect',
  rect: { x: 100, y: 200, w: 80, h: 40 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  stroke: [0, 0, 0], strokeWidth: 1, fill: null,
}

/** `currentTarget` is getter-only; the browser sets it during dispatch. */
function pointerDown(x: number, y: number): PointerEvent {
  const e = new Event('pointerdown', { bubbles: true }) as PointerEvent
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1 })
  Object.defineProperty(e, 'currentTarget', { value: document.createElement('div'), configurable: true })
  return e
}

function move(x: number, y: number): void {
  const e = new Event('pointermove', { bubbles: true }) as PointerEvent
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1 })
  window.dispatchEvent(e)
}

function up(): void {
  const e = new Event('pointerup', { bubbles: true }) as PointerEvent
  Object.assign(e, { clientX: 0, clientY: 0, pointerId: 1 })
  window.dispatchEvent(e)
}

describe('SelectionChrome', () => {
  let edits: ReturnType<typeof useEditsStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'], { p1: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
    edits.applyOp({ type: 'addObject', object }, 'add')
  })

  /**
   * A text patch's rect is MuPDF page space, not the bottom-up PDF space
   * every other object uses, so the selection box has to read it that way
   * or it lands at the mirror image of the line -- which is what the layers
   * list showed: the box near the top of the page for a line near the
   * bottom.
   */
  it('boxes an edited line where the line is, not at its mirror image', () => {
    const patch = {
      id: 'tp1', pageId: 'p1', kind: 'textPatch',
      rect: { x: 100, y: 600, w: 80, h: 12 },
      rotation: 0, z: 3, locked: false, opacity: 1,
      lineIndex: 3, originalHash: 'h', originalText: 'Total Amount', text: 'Total TK',
      fontFamily: 'Helvetica', fontSize: 0, color: [0, 0, 0], background: [1, 1, 1],
      backgroundConfidence: 1, fit: 'shrink',
    } as unknown as EditObject
    edits.applyOp({ type: 'addObject', object: patch }, 'add')
    edits.select(['tp1'])

    const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
    expect(w.get('[data-selection]').attributes('style')).toContain('top: 600px')
  })

  /**
   * A moved image drags the way an edited line does -- into `offset`, never
   * into the rect. The cover has to stay over the document's own image, or
   * that image reappears from underneath the copy the drag is carrying.
   */
  describe('dragging a moved image', () => {
    const imagePatch = (over: Record<string, unknown> = {}): EditObject => ({
      id: 'ip1', pageId: 'p1', kind: 'imagePatch',
      rect: { x: 100, y: 600, w: 200, h: 100 },
      rotation: 0, z: 3, locked: false, opacity: 1,
      imageIndex: 0, originalHash: 'aaaa1111',
      background: [1, 1, 1], backgroundConfidence: 1,
      data: new Uint8Array([1, 2, 3]), mime: 'image/png',
      ...over,
    } as unknown as EditObject)

    const selectedPatch = (over: Record<string, unknown> = {}) => {
      edits.applyOp({ type: 'addObject', object: imagePatch(over) }, 'add')
      edits.select(['ip1'])
      return mount(SelectionChrome, { props: { page, zoom: 1 } })
    }

    it('boxes it where the image is, not at its mirror image', () => {
      const w = selectedPatch()
      expect(w.get('[data-selection]').attributes('style')).toContain('top: 600px')
    })

    it('accumulates the drag into the offset', async () => {
      const w = selectedPatch()
      await w.get('[data-selection]').element.dispatchEvent(pointerDown(0, 0))
      move(40, 25)
      up()
      expect((edits.doc.objects.ip1 as { offset?: { dx: number; dy: number } }).offset)
        .toEqual({ dx: 40, dy: 25 })
    })

    it('leaves the rect alone, so the cover stays over the original', async () => {
      const w = selectedPatch()
      await w.get('[data-selection]').element.dispatchEvent(pointerDown(0, 0))
      move(40, 25)
      up()
      expect(edits.doc.objects.ip1!.rect).toEqual({ x: 100, y: 600, w: 200, h: 100 })
    })

    it('adds to an offset it already had', async () => {
      const w = selectedPatch({ offset: { dx: 10, dy: -5 } })
      await w.get('[data-selection]').element.dispatchEvent(pointerDown(0, 0))
      move(40, 25)
      up()
      expect((edits.doc.objects.ip1 as { offset?: { dx: number; dy: number } }).offset)
        .toEqual({ dx: 50, dy: 20 })
    })

    /**
     * Resize handles, once it carries a copy: that copy is a picture with
     * a size of its own, stored separately from the rect precisely so the
     * two can differ.
     */
    it('offers resize handles once it carries a copy', () => {
      const w = selectedPatch()
      expect(w.findAll('[data-handle]').length).toBeGreaterThan(0)
    })

    /**
     * NOT rotate. The writer places the copy with a plain scale-and-
     * translate matrix, so a rotation would be an edit that silently does
     * nothing.
     */
    it('offers no rotate handle', () => {
      expect(selectedPatch().find('[data-rotate-handle]').exists()).toBe(false)
    })

    /** Nothing to resize while it is only a cover. */
    it('offers no handles while it carries nothing', () => {
      const w = selectedPatch({ data: undefined })
      expect(w.findAll('[data-handle]')).toHaveLength(0)
    })

    it('resizes the copy from the south-east handle without moving it', async () => {
      const w = selectedPatch()
      await w.get('[data-handle="se"]').element.dispatchEvent(pointerDown(0, 0))
      move(50, 30)
      up()
      const o = edits.doc.objects.ip1 as unknown as {
        size?: { w: number; h: number }
        offset?: { dx: number; dy: number }
        rect: { x: number; y: number; w: number; h: number }
      }
      expect(o.size).toEqual({ w: 250, h: 130 })
      expect(o.offset ?? { dx: 0, dy: 0 }).toEqual({ dx: 0, dy: 0 })
      // The cover has to stay over the page's own image.
      expect(o.rect).toEqual({ x: 100, y: 600, w: 200, h: 100 })
    })

    /** Dragging a north or west handle moves the top-left corner too. */
    it('moves the copy when the north-west handle is dragged', async () => {
      const w = selectedPatch()
      await w.get('[data-handle="nw"]').element.dispatchEvent(pointerDown(0, 0))
      move(20, 10)
      up()
      const o = edits.doc.objects.ip1 as unknown as {
        size: { w: number; h: number }
        offset: { dx: number; dy: number }
      }
      expect(o.size).toEqual({ w: 180, h: 90 })
      expect(o.offset).toEqual({ dx: 20, dy: 10 })
    })

    it('never shrinks past the minimum, and stops moving when it gets there', async () => {
      const w = selectedPatch()
      await w.get('[data-handle="nw"]').element.dispatchEvent(pointerDown(0, 0))
      move(10_000, 10_000)
      up()
      const o = edits.doc.objects.ip1 as unknown as {
        size: { w: number; h: number }
        offset: { dx: number; dy: number }
      }
      expect(o.size.w).toBeGreaterThan(0)
      expect(o.size.h).toBeGreaterThan(0)
      // The left edge stopped where the width bottomed out, rather than
      // carrying on across the page.
      expect(o.offset.dx).toBe(200 - o.size.w)
      expect(o.offset.dy).toBe(100 - o.size.h)
    })

    it('adds to a size it already had', async () => {
      const w = selectedPatch({ size: { w: 50, h: 25 } })
      await w.get('[data-handle="se"]').element.dispatchEvent(pointerDown(0, 0))
      move(10, 5)
      up()
      expect((edits.doc.objects.ip1 as unknown as { size: { w: number; h: number } }).size)
        .toEqual({ w: 60, h: 30 })
    })
  })

  /**
   * Double-clicking a selected text object reopens it for editing.
   *
   * `ObjectLayer` has a `dblclick` that does this, and once the object was
   * selected it could never fire: this box covers the object with
   * `pointer-events-auto` and stops the pointer on the way down, so every
   * gesture landed here. Moving worked and editing did not, which is
   * exactly how it was reported -- "added text i can't change but i can
   * move".
   */
  describe('reopening a text object', () => {
    const text: EditObject = {
      id: 't1', pageId: 'p1', kind: 'text',
      rect: { x: 100, y: 200, w: 120, h: 30 },
      rotation: 0, z: 2, locked: false, opacity: 1,
      text: 'Simple', fontFamily: 'Inter', fontSize: 14, color: [0, 0, 0], align: 'left',
    } as EditObject

    it('starts editing on a double-click', async () => {
      const tools = useToolsStore()
      edits.applyOp({ type: 'addObject', object: text }, 'add')
      edits.select(['t1'])

      const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
      await w.get('[data-selection]').trigger('dblclick')

      expect(tools.editingId).toBe('t1')
    })

    /** A locked object is locked against editing, not only against dragging. */
    it('leaves a locked text object alone', async () => {
      const tools = useToolsStore()
      edits.applyOp({ type: 'addObject', object: { ...text, locked: true } }, 'add')
      edits.select(['t1'])

      const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
      await w.get('[data-selection]').trigger('dblclick')

      expect(tools.editingId).toBeUndefined()
    })

    /** Only text has an editor; a rectangle has nothing to open. */
    it('does nothing for an object that is not text', async () => {
      const tools = useToolsStore()
      edits.select(['o1'])

      const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
      await w.get('[data-selection]').trigger('dblclick')

      expect(tools.editingId).toBeUndefined()
    })
  })

  it('renders nothing when there is no selection', () => {
    const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
    expect(w.find('[data-selection]').exists()).toBe(false)
  })

  it('renders eight resize handles plus a rotate handle when selected', () => {
    edits.select(['o1'])
    const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
    expect(w.findAll('[data-handle]')).toHaveLength(8)
    expect(w.find('[data-rotate-handle]').exists()).toBe(true)
  })

  it('positions the box in view space, accounting for the y-flip', () => {
    edits.select(['o1'])
    const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
    const box = w.find('[data-selection]').element as HTMLElement
    // PDF y=200..240 on a 792pt page -> view top = 792-240 = 552.
    expect(box.style.left).toBe('100px')
    expect(box.style.top).toBe('552px')
    expect(box.style.width).toBe('80px')
    expect(box.style.height).toBe('40px')
  })

  it('scales the box with zoom', () => {
    edits.select(['o1'])
    const w = mount(SelectionChrome, { props: { page, zoom: 2 } })
    const box = w.find('[data-selection]').element as HTMLElement
    expect(box.style.left).toBe('200px')
    expect(box.style.width).toBe('160px')
  })

  it('shows no handles on a locked object', () => {
    edits.applyOp({ type: 'updateObject', id: 'o1', patch: { locked: true } }, 'lock')
    edits.select(['o1'])
    const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
    expect(w.findAll('[data-handle]')).toHaveLength(0)
  })

  it('drags the object in PDF space, inverting the view-space y', () => {
    edits.select(['o1'])
    const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
    w.find('[data-selection]').element.dispatchEvent(pointerDown(0, 0))
    move(30, 10)
    up()
    // View +x is PDF +x; view +y is DOWN, so PDF y decreases.
    expect(edits.doc.objects.o1?.rect.x).toBe(130)
    expect(edits.doc.objects.o1?.rect.y).toBe(190)
  })

  // The whole point of the gesture transaction: one drag is one undo step.
  it('records a whole drag as a single undo step', () => {
    edits.select(['o1'])
    const before = edits.historySize
    const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
    w.find('[data-selection]').element.dispatchEvent(pointerDown(0, 0))
    for (let i = 1; i <= 20; i++) move(i, 0)
    up()
    expect(edits.historySize).toBe(before + 1)
    edits.undo()
    expect(edits.doc.objects.o1?.rect.x).toBe(100)
  })

  it('resizes from the east handle without moving the west edge', () => {
    edits.select(['o1'])
    const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
    w.find('[data-handle="e"]').element.dispatchEvent(pointerDown(0, 0))
    move(20, 0)
    up()
    expect(edits.doc.objects.o1?.rect.x).toBe(100)
    expect(edits.doc.objects.o1?.rect.w).toBe(100)
  })

  it('clamps a resize to a minimum size rather than inverting the rect', () => {
    edits.select(['o1'])
    const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
    w.find('[data-handle="e"]').element.dispatchEvent(pointerDown(0, 0))
    move(-500, 0)
    up()
    expect(edits.doc.objects.o1?.rect.w).toBe(4)
  })

  // Rotation is the angle of the pointer ABOUT THE BOX CENTRE, not the angle
  // of the drag delta. Dragging the top-centre handle horizontally to the
  // right swings it clockwise on screen; PDF rotation is counterclockwise-
  // positive (the overlay root <g> carries a y-flip), so it must DECREASE.
  it('rotates by the pointer angle about the centre, counterclockwise-positive', () => {
    edits.select(['o1'])
    const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
    w.find('[data-rotate-handle]').element.dispatchEvent(pointerDown(0, 0))
    // The handle starts 24px above the box top, i.e. h/2 + 24 = 44px above
    // the centre. Moving it +44 right and +44 down lands it level with the
    // centre and 44px to its right -- a quarter turn clockwise on screen,
    // so PDF rotation goes 0 -> -90, normalised to 270.
    move(44, 44)
    up()
    expect(edits.doc.objects.o1?.rotation).toBe(270)
  })

  /**
   * Dragging an edited line.
   *
   * A patch is not moved by rewriting its rect, the way every other object
   * is. Its rect is the line it REPLACES -- the cover is drawn from it and
   * the cover must not move, or the document's own glyphs reappear from
   * underneath. So the drag writes `offset`, and the rect stays put.
   */
  describe('dragging an edited line', () => {
    const patch = (over: Record<string, unknown> = {}): EditObject => ({
      id: 'tp1', pageId: 'p1', kind: 'textPatch',
      rect: { x: 100, y: 600, w: 80, h: 12 },
      rotation: 0, z: 3, locked: false, opacity: 1,
      lineIndex: 0, originalHash: 'h', originalText: 'Total Amount', text: 'Total TK',
      fontFamily: 'Helvetica', fontSize: 0, baseline: 612, color: [0, 0, 0],
      background: [1, 1, 1], backgroundConfidence: 1, fit: 'shrink',
      ...over,
    } as unknown as EditObject)

    const drag = (zoom: number, dx: number, dy: number): void => {
      const w = mount(SelectionChrome, { props: { page, zoom } })
      w.find('[data-selection]').element.dispatchEvent(pointerDown(0, 0))
      move(dx, dy)
      up()
    }

    const patched = () => edits.doc.objects.tp1 as unknown as {
      rect: { x: number; y: number }
      offset?: { dx: number; dy: number }
      pageId: string
    }

    beforeEach(() => {
      edits.applyOp({ type: 'addObject', object: patch() }, 'add')
      edits.select(['tp1'])
    })

    it('writes an offset rather than a rect', () => {
      drag(1, 30, 10)
      // Page space is top-down like the screen, so a downward drag is
      // POSITIVE dy -- no inversion, unlike the PDF-space case above.
      expect(patched().offset).toEqual({ dx: 30, dy: 10 })
    })

    it('leaves the rect on the line, so the cover stays where the glyphs are', () => {
      drag(1, 30, 10)
      expect(patched().rect).toEqual({ x: 100, y: 600, w: 80, h: 12 })
    })

    it('converts the drag out of view pixels', () => {
      drag(2, 30, 10)
      expect(patched().offset).toEqual({ dx: 15, dy: 5 })
    })

    it('adds to an offset the patch already had', () => {
      edits.applyOp(
        { type: 'updateObject', id: 'tp1', patch: { offset: { dx: 5, dy: 7 } } as never },
        'seed',
      )
      drag(1, 30, 10)
      expect(patched().offset).toEqual({ dx: 35, dy: 17 })
    })

    it('records the whole drag as one undo step', () => {
      const before = edits.historySize
      const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
      w.find('[data-selection]').element.dispatchEvent(pointerDown(0, 0))
      for (let i = 1; i <= 20; i++) move(i, i)
      up()
      expect(edits.historySize).toBe(before + 1)
      edits.undo()
      expect(patched().offset).toBeUndefined()
    })

    /**
     * A patch has no size of its own -- its box is the line's -- and no
     * rotation the writer would honour, since the replacement is drawn on
     * the line's own baseline. Offering handles for either is offering an
     * edit that silently does nothing.
     */
    it('offers no resize or rotate handles', () => {
      const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
      expect(w.findAll('[data-handle]')).toHaveLength(0)
      expect(w.find('[data-rotate-handle]').exists()).toBe(false)
    })

    /**
     * A patch is addressed by (pageId, lineIndex) into ONE page's
     * extraction. Dropped on another page it would point at a line that
     * hashes differently, and the export would refuse the whole document.
     */
    it('stays on its own page', () => {
      drag(1, 30, 900)
      expect(patched().pageId).toBe('p1')
    })

    /**
     * The rails are feedback for a gesture in progress, so they go up when
     * the pointer goes down and come back down when it lifts -- including
     * when the gesture is cancelled, or they outlive the drag that raised
     * them and stay on the page for good.
     */
    it('raises the alignment rails for the drag and lowers them after', () => {
      const tools = useToolsStore()
      const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
      w.find('[data-selection]').element.dispatchEvent(pointerDown(0, 0))
      expect(tools.movingPatchId).toBe('tp1')
      move(10, 10)
      expect(tools.movingPatchId).toBe('tp1')
      up()
      expect(tools.movingPatchId).toBeUndefined()
    })

    it('lowers them on a cancelled gesture too', () => {
      const tools = useToolsStore()
      const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
      w.find('[data-selection]').element.dispatchEvent(pointerDown(0, 0))
      const e = new Event('pointercancel', { bubbles: true })
      Object.assign(e, { clientX: 0, clientY: 0, pointerId: 1 })
      window.dispatchEvent(e)
      expect(tools.movingPatchId).toBeUndefined()
    })

    /** Dragging anything else must not raise them. */
    it('does not raise them for an ordinary object', () => {
      const tools = useToolsStore()
      edits.select(['o1'])
      const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
      w.find('[data-selection]').element.dispatchEvent(pointerDown(0, 0))
      expect(tools.movingPatchId).toBeUndefined()
      up()
    })

    /**
     * Snapping, which needs the page's text to have rails to snap to. The
     * arithmetic itself is `snapOffset`'s; what these pin is that the
     * chrome hands it the right numbers and converts the threshold out of
     * view pixels.
     */
    describe('snapping to the page’s rails', () => {
      // One other line, giving a vertical rail at x 300 and a horizontal
      // one at its baseline, 216.
      const index = {
        lines: [
          {
            bbox: [100, 600, 180, 612], text: 'ab', font: 'Helvetica',
            bold: false, italic: false, color: [0, 0, 0], size: 10, baseline: 610,
            chars: [{ char: 'a', quad: [100, 600, 180, 600, 100, 612, 180, 612] }],
          },
          {
            bbox: [300, 204, 380, 216], text: 'cd', font: 'Helvetica',
            bold: false, italic: false, color: [0, 0, 0], size: 10, baseline: 216,
            chars: [{ char: 'c', quad: [300, 204, 380, 204, 300, 216, 380, 216] }],
          },
        ],
      }

      const dragWith = (zoom: number, dx: number, dy: number): void => {
        const w = mount(SelectionChrome, { props: { page, zoom, index: index as never } })
        w.find('[data-selection]').element.dispatchEvent(pointerDown(0, 0))
        move(dx, dy)
        up()
      }

      it('pulls the line onto a rail it lands near', () => {
        // The patch's left edge is x 100; a drag of 198 puts it at 298,
        // two points from the rail at 300.
        dragWith(1, 198, 0)
        expect(patched().offset?.dx).toBe(200)
      })

      it('leaves it where it was dropped when no rail is near', () => {
        dragWith(1, 50, 0)
        expect(patched().offset?.dx).toBe(50)
      })

      /**
       * The threshold is view pixels, so it feels the same at every zoom.
       * At 4x, the same 6px reach is 1.5pt of page -- and a drag that
       * would have snapped at 100% no longer does.
       */
      /**
       * The threshold is view pixels, so it feels the same at every zoom --
       * which means the same page distance stops snapping as you zoom in.
       * Separate cases because a drag leaves its offset behind, and a
       * second one in the same test would start from it.
       */
      it('still snaps at 4x when the gap is inside the reach in pixels', () => {
        // 796 view px at 4x is 199pt, putting the left edge one point from
        // the rail. The 6px reach is 1.5pt here, so it still snaps.
        dragWith(4, 796, 0)
        expect(patched().offset?.dx).toBe(200)
      })

      it('stops snapping at 4x for a gap that would have snapped at 1x', () => {
        // 788 at 4x is 197pt: three points out, outside 1.5pt -- while the
        // same three points at 1x is well inside six.
        dragWith(4, 788, 0)
        expect(patched().offset?.dx).toBe(197)
      })

      /** The line's own rails are excluded, or it would snap to itself. */
      it('does not snap the line to where it already was', () => {
        dragWith(1, 2, 0)
        expect(patched().offset?.dx).toBe(2)
      })

      it('snaps the baseline to another line’s baseline', () => {
        // The patch's baseline is 612; the other line's is 216, so a drag
        // of -394 lands two points away.
        dragWith(1, 0, -394)
        expect(patched().offset?.dy).toBe(-396)
      })

      it('snaps nothing before the page’s text has been extracted', () => {
        const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
        w.find('[data-selection]').element.dispatchEvent(pointerDown(0, 0))
        move(198, 0)
        up()
        expect(patched().offset?.dx).toBe(198)
      })
    })

    it('leaves a locked patch untouched', () => {
      edits.applyOp({ type: 'updateObject', id: 'tp1', patch: { locked: true } }, 'lock')
      drag(1, 30, 10)
      expect(patched().offset).toBeUndefined()
    })
  })

  it('leaves a locked object untouched by a drag', () => {
    edits.applyOp({ type: 'updateObject', id: 'o1', patch: { locked: true } }, 'lock')
    edits.select(['o1'])
    const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
    w.find('[data-selection]').element.dispatchEvent(pointerDown(0, 0))
    move(50, 50)
    up()
    expect(edits.doc.objects.o1?.rect.x).toBe(100)
  })
})
