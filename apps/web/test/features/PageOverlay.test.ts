import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import PageOverlay from '@/features/overlay/PageOverlay.vue'
import { useEditsStore } from '@/stores/edits'
import type { PageState } from '@/stores/document'
import type { EditObject } from '@margin/pdf-core'

const page: PageState = {
  id: 'p1',
  sourceId: 'src-0',
  sourceIndex: 0,
  geometry: { cropBox: [0, 0, 612, 792], rotate: 0 },
}

const turned: PageState = {
  id: 'p2',
  sourceId: 'src-0',
  sourceIndex: 1,
  geometry: { cropBox: [0, 0, 612, 792], rotate: 90 },
}

function obj(id: string, pageId: string, z = 1): EditObject {
  return {
    id, pageId, kind: 'rect',
    rect: { x: 10, y: 20, w: 100, h: 50 },
    rotation: 0, z, locked: false, opacity: 1,
    stroke: [0, 0, 0], strokeWidth: 1, fill: null,
  }
}

describe('PageOverlay', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useEditsStore().reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1', 'p2'], { p1: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null }, p2: { sourceIndex: 1, sourceId: 'src-0', rotation: 0, cropBox: null } })
  })

  it('sets the viewBox to the page dimensions in points', () => {
    const w = mount(PageOverlay, { props: { page, zoom: 1 } })
    expect(w.find('svg').attributes('viewBox')).toBe('0 0 612 792')
  })

  it('swaps the viewBox extent on a quarter-turned page', () => {
    const w = mount(PageOverlay, { props: { page: turned, zoom: 1 } })
    expect(w.find('svg').attributes('viewBox')).toBe('0 0 792 612')
  })

  it('keeps the viewBox constant across zoom — zoom is a CSS concern only', () => {
    const a = mount(PageOverlay, { props: { page, zoom: 1 } })
    const b = mount(PageOverlay, { props: { page, zoom: 3.5 } })
    expect(b.find('svg').attributes('viewBox')).toBe(a.find('svg').attributes('viewBox'))
  })

  it('puts the page transform on a single root group', () => {
    const w = mount(PageOverlay, { props: { page, zoom: 1 } })
    const groups = w.findAll('svg > g')
    expect(groups).toHaveLength(1)
    expect(groups[0]!.attributes('transform')).toContain('scale(1 -1)')
  })

  it('renders only the objects belonging to this page', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: obj('a', 'p1') }, 'add')
    s.applyOp({ type: 'addObject', object: obj('b', 'p2') }, 'add')
    const w = mount(PageOverlay, { props: { page, zoom: 1 } })
    expect(w.findAll('[data-object-id]')).toHaveLength(1)
    expect(w.find('[data-object-id]').attributes('data-object-id')).toBe('a')
  })

  it('renders objects in ascending z order', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: obj('high', 'p1', 9) }, 'add')
    s.applyOp({ type: 'addObject', object: obj('low', 'p1', 1) }, 'add')
    const ids = mount(PageOverlay, { props: { page, zoom: 1 } })
      .findAll('[data-object-id]')
      .map((n) => n.attributes('data-object-id'))
    expect(ids).toEqual(['low', 'high'])
  })

  it('is pointer-transparent where there is no object', () => {
    const w = mount(PageOverlay, { props: { page, zoom: 1 } })
    expect(w.find('svg').classes()).toContain('pointer-events-none')
  })
})

// Task 37 added a full-page text hit-target. It must sit BELOW the <svg>:
// objects are pointer-events-auto inside a pointer-events-none svg, so a
// text surface stacked above them would make every object unselectable
// under the select tool — the overlay's single most-used interaction.
describe('PageOverlay layering', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useEditsStore().reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1', 'p2'], { p1: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null }, p2: { sourceIndex: 1, sourceId: 'src-0', rotation: 0, cropBox: null } })
  })

  it('puts the text surface before the svg in document order', () => {
    const w = mount(PageOverlay, { props: { page, zoom: 1 } })
    const surface = w.find('[data-text-surface]')
    const svg = w.find('svg')
    expect(surface.exists()).toBe(true)
    // DOCUMENT_POSITION_FOLLOWING: the svg comes after the surface, so the
    // svg (and the objects inside it) paint and hit-test on top.
    const relation = surface.element.compareDocumentPosition(svg.element)
    expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('still routes a pointerdown on an object to selecting that object', async () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: obj('a', 'p1') }, 'add')
    const w = mount(PageOverlay, { props: { page, zoom: 1 } })
    await w.get('[data-object-id="a"]').trigger('pointerdown')
    expect(s.selection).toEqual(['a'])
  })
})
