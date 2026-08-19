import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import PageOverlay from '@/features/overlay/PageOverlay.vue'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { useDocumentStore } from '@/stores/document'
import { setUriPrompt } from '@/features/overlay/useDrawTool'
import type { PageState } from '@/stores/document'

const page: PageState = { id: 'p1', sourceId: 'src-0', sourceIndex: 0, geometry: { cropBox: [0, 0, 612, 792], rotate: 0 } }

/**
 * jsdom gives every element a zero-size, zero-origin client rect, which is
 * fine for a page whose overlay sits at the viewport origin -- but stubbing
 * it explicitly is what makes the expected PDF coordinates below readable
 * rather than an accident of jsdom's defaults.
 */
function stubRect(el: Element, left = 0, top = 0): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left, top, right: left + 612, bottom: top + 792, width: 612, height: 792, x: left, y: top,
    toJSON: () => ({}),
  } as DOMRect)
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

describe('drawing shapes', () => {
  let edits: ReturnType<typeof useEditsStore>
  let tools: ReturnType<typeof useToolsStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    tools = useToolsStore()
    edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'], { p1: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
  })

  function overlay() {
    const w = mount(PageOverlay, { props: { page, zoom: 1 }, attachTo: document.body })
    const surface = w.find('[data-draw-surface]')
    if (surface.exists()) stubRect(surface.element)
    return w
  }

  it('mounts no capture surface for the select tool', () => {
    expect(overlay().find('[data-draw-surface]').exists()).toBe(false)
  })

  it('mounts a capture surface for a drawing tool', () => {
    tools.setTool('rect')
    expect(overlay().find('[data-draw-surface]').exists()).toBe(true)
  })

  it('creates one object at the dragged PDF-space rect', () => {
    tools.setTool('rect')
    const w = overlay()
    down(w.get('[data-draw-surface]').element, 100, 200)
    move(200, 300)
    up()
    const objects = Object.values(edits.doc.objects)
    expect(objects).toHaveLength(1)
    // View y 200..300 on a 792pt page -> PDF y 492..592, bottom edge 492.
    expect(objects[0]).toMatchObject({
      kind: 'rect',
      rect: { x: 100, y: 492, w: 100, h: 100 },
    })
  })

  it('records the whole drag as one history entry', () => {
    tools.setTool('rect')
    const w = overlay()
    down(w.get('[data-draw-surface]').element, 100, 200)
    for (let i = 1; i <= 20; i++) move(100 + i * 5, 200 + i * 5)
    up()
    expect(edits.historySize).toBe(1)
  })

  it('discards a stray click rather than committing a zero-size object', () => {
    tools.setTool('rect')
    const w = overlay()
    down(w.get('[data-draw-surface]').element, 100, 200)
    move(101, 201)
    up()
    expect(Object.keys(edits.doc.objects)).toHaveLength(0)
    expect(edits.historySize).toBe(0)
  })

  it('keeps the drag direction for an arrow, so the head lands where drawn', () => {
    tools.setTool('arrow')
    const w = overlay()
    // Dragged right-to-left: w must stay negative.
    down(w.get('[data-draw-surface]').element, 300, 200)
    move(100, 200)
    up()
    const o = Object.values(edits.doc.objects)[0]!
    expect(o.rect.x).toBe(300)
    expect(o.rect.w).toBe(-200)
  })

  it('hands the finished shape to the select tool, already selected', () => {
    tools.setTool('ellipse')
    const w = overlay()
    down(w.get('[data-draw-surface]').element, 100, 200)
    move(200, 300)
    up()
    expect(tools.active).toBe('select')
    expect(edits.selection).toEqual([Object.keys(edits.doc.objects)[0]])
  })

  it('shows a live draft while dragging that never enters history', () => {
    tools.setTool('rect')
    const w = overlay()
    down(w.get('[data-draw-surface]').element, 100, 200)
    move(200, 300)
    expect(tools.draft).toBeDefined()
    expect(edits.historySize).toBe(0)
    expect(Object.keys(edits.doc.objects)).toHaveLength(0)
    up()
    expect(tools.draft).toBeUndefined()
  })

  it('converts through the zoom, so a 2x drag is half the PDF size', () => {
    tools.setTool('rect')
    const w = mount(PageOverlay, { props: { page, zoom: 2 }, attachTo: document.body })
    stubRect(w.get('[data-draw-surface]').element)
    down(w.get('[data-draw-surface]').element, 100, 200)
    move(300, 400)
    up()
    expect(Object.values(edits.doc.objects)[0]).toMatchObject({ rect: { w: 100, h: 100 } })
  })
})

describe('drawing a link', () => {
  let edits: ReturnType<typeof useEditsStore>
  let tools: ReturnType<typeof useToolsStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    tools = useToolsStore()
    edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'], { p1: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
  })

  afterEach(() => setUriPrompt(undefined))

  function drag() {
    const w = mount(PageOverlay, { props: { page, zoom: 1 }, attachTo: document.body })
    stubRect(w.get('[data-draw-surface]').element)
    down(w.get('[data-draw-surface]').element, 100, 200)
    move(300, 240)
    up()
    return w
  }

  it('normalises a bare domain into an https URL', () => {
    tools.setTool('link')
    setUriPrompt(() => 'example.com/a')
    drag()
    expect(Object.values(edits.doc.objects)[0]).toMatchObject({
      kind: 'link', uri: 'https://example.com/a',
    })
  })

  // Spec 2.1: a javascript: URL must never reach the export path, so it is
  // refused at op-creation time and no object is produced at all.
  it('creates nothing for a javascript: URL and says why', () => {
    tools.setTool('link')
    setUriPrompt(() => 'javascript:alert(1)')
    drag()
    expect(Object.keys(edits.doc.objects)).toHaveLength(0)
    expect(useDocumentStore().error).toMatch(/not allowed/i)
  })

  it('creates nothing when the prompt is cancelled', () => {
    tools.setTool('link')
    setUriPrompt(() => null)
    drag()
    expect(Object.keys(edits.doc.objects)).toHaveLength(0)
    expect(edits.historySize).toBe(0)
  })
})
