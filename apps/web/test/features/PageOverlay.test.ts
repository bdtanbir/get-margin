import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import PageOverlay from '@/features/overlay/PageOverlay.vue'
import { useEditsStore } from '@/stores/edits'
import type { PageState } from '@/stores/document'
import type { EditObject } from '@margin/pdf-core'

const page: PageState = {
  id: 'p1',
  sourceIndex: 0,
  geometry: { cropBox: [0, 0, 612, 792], rotate: 0 },
}

const turned: PageState = {
  id: 'p2',
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
    useEditsStore().reset('h', ['p1', 'p2'], { p1: { sourceIndex: 0 }, p2: { sourceIndex: 1 } })
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
