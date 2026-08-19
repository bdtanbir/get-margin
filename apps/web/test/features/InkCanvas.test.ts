import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import InkCanvas from '@/features/overlay/InkCanvas.vue'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import type { PageState } from '@/stores/document'
import type { InkObject } from '@margin/pdf-core'

const page: PageState = { id: 'p1', sourceIndex: 0, geometry: { cropBox: [0, 0, 612, 792], rotate: 0 } }

/** jsdom canvases have no 2D context; the component must not depend on one. */
const ctx2d = {
  clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
  stroke: vi.fn(), setTransform: vi.fn(),
  strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '',
}

function down(el: Element, x: number, y: number): void {
  const e = new Event('pointerdown', { bubbles: true }) as PointerEvent
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1 })
  el.dispatchEvent(e)
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

describe('InkCanvas', () => {
  let edits: ReturnType<typeof useEditsStore>
  let tools: ReturnType<typeof useToolsStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    tools = useToolsStore()
    edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'], { p1: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx2d) as never
    HTMLCanvasElement.prototype.setPointerCapture = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 612, bottom: 792, width: 612, height: 792, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect)
  })

  const mountFor = (zoom = 1) =>
    mount(InkCanvas, { props: { page, zoom }, attachTo: document.body })

  function stroke(w: ReturnType<typeof mountFor>): void {
    down(w.get('[data-ink-canvas]').element, 100, 200)
    for (let i = 1; i <= 10; i++) move(100 + i * 10, 200 + i * 2)
    up()
  }

  it('mounts nothing unless the ink tool is active', () => {
    expect(mountFor().find('[data-ink-canvas]').exists()).toBe(false)
  })

  it('mounts a canvas for the ink tool', () => {
    tools.setTool('ink')
    expect(mountFor().find('[data-ink-canvas]').exists()).toBe(true)
  })

  // The point of the transient canvas: nothing reaches the store, and so
  // nothing re-renders the overlay, until the stroke is finished.
  it('commits nothing until pointerup', () => {
    tools.setTool('ink')
    const w = mountFor()
    down(w.get('[data-ink-canvas]').element, 100, 200)
    for (let i = 1; i <= 10; i++) move(100 + i * 10, 200)
    expect(Object.keys(edits.doc.objects)).toHaveLength(0)
    expect(edits.historySize).toBe(0)
    up()
    expect(Object.keys(edits.doc.objects)).toHaveLength(1)
  })

  it('commits one object and one history entry per stroke', () => {
    tools.setTool('ink')
    const w = mountFor()
    stroke(w)
    stroke(w)
    expect(Object.keys(edits.doc.objects)).toHaveLength(2)
    expect(edits.historySize).toBe(2)
  })

  it('stores points in PDF space, with y inverted from view space', () => {
    tools.setTool('ink')
    const w = mountFor()
    down(w.get('[data-ink-canvas]').element, 100, 200)
    move(200, 300)
    move(300, 400)
    up()
    const o = Object.values(edits.doc.objects)[0] as InkObject
    // View y 200 on a 792pt page -> PDF y 592.
    expect(o.strokes).toHaveLength(1)
    expect(o.strokes[0]!.slice(0, 6)).toEqual([100, 592, 200, 492, 300, 392])
  })

  it('converts through the zoom', () => {
    tools.setTool('ink')
    const w = mountFor(2)
    down(w.get('[data-ink-canvas]').element, 100, 200)
    move(300, 200)
    up()
    const o = Object.values(edits.doc.objects)[0] as InkObject
    expect(o.strokes[0]![0]).toBe(50)
    expect(o.strokes[0]![2]).toBe(150)
  })

  it('gives the object a rect that encloses the stroke', () => {
    tools.setTool('ink')
    const w = mountFor()
    stroke(w)
    const o = Object.values(edits.doc.objects)[0] as InkObject
    const xs = o.strokes[0]!.filter((_, i) => i % 2 === 0)
    const ys = o.strokes[0]!.filter((_, i) => i % 2 === 1)
    expect(o.rect.x).toBeLessThanOrEqual(Math.min(...xs))
    expect(o.rect.y).toBeLessThanOrEqual(Math.min(...ys))
    expect(o.rect.x + o.rect.w).toBeGreaterThanOrEqual(Math.max(...xs))
    expect(o.rect.y + o.rect.h).toBeGreaterThanOrEqual(Math.max(...ys))
  })

  it('discards a tap rather than committing a dot', () => {
    tools.setTool('ink')
    const w = mountFor()
    down(w.get('[data-ink-canvas]').element, 100, 200)
    move(100.5, 200.5)
    up()
    expect(Object.keys(edits.doc.objects)).toHaveLength(0)
  })

  it('abandons the stroke on pointercancel', () => {
    tools.setTool('ink')
    const w = mountFor()
    down(w.get('[data-ink-canvas]').element, 100, 200)
    move(200, 300)
    const e = new Event('pointercancel', { bubbles: true }) as PointerEvent
    Object.assign(e, { clientX: 0, clientY: 0, pointerId: 1 })
    window.dispatchEvent(e)
    // A cancelled gesture commits nothing, and a later move must not revive it.
    move(400, 400)
    up()
    expect(Object.keys(edits.doc.objects)).toHaveLength(0)
  })

  it('stops listening after unmount', () => {
    tools.setTool('ink')
    const w = mountFor()
    down(w.get('[data-ink-canvas]').element, 100, 200)
    w.unmount()
    move(400, 400)
    up()
    expect(Object.keys(edits.doc.objects)).toHaveLength(0)
  })
})
