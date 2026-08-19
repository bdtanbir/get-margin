import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SelectionChrome from '@/features/overlay/SelectionChrome.vue'
import { useEditsStore } from '@/stores/edits'
import type { PageState } from '@/stores/document'
import type { EditObject } from '@margin/pdf-core'

const page: PageState = { id: 'p1', sourceIndex: 0, geometry: { cropBox: [0, 0, 612, 792], rotate: 0 } }

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
