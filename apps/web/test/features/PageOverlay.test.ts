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

  /**
   * Spec 1.3, Layer 2: the page transform comes from `@margin/transform`
   * and objects render at their raw stored coordinates with no per-object
   * maths.
   *
   * This used to assert "exactly one root group", which was a proxy for
   * that and stopped being a valid one: painting order has to follow z
   * across both coordinate spaces, and page-space objects cannot go inside
   * the flipped group, so the two interleave into runs. What still has to
   * hold -- and what this asserts now -- is that every raw-PDF object sits
   * under the SAME transform, whatever the grouping.
   */
  it('puts the page transform, and only it, on the raw-PDF groups', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: obj('a', 'p1', 1) }, 'add')
    const w = mount(PageOverlay, { props: { page, zoom: 1 } })
    const groups = w.findAll('svg > g')
    expect(groups).toHaveLength(1)
    expect(groups[0]!.attributes('transform')).toContain('scale(1 -1)')
  })

  it('renders no group at all for a page with nothing on it', () => {
    expect(mount(PageOverlay, { props: { page, zoom: 1 } }).findAll('svg > g')).toHaveLength(0)
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

  /**
   * Objects whose geometry is MuPDF PAGE space -- patches, markup,
   * redaction -- render outside the y-flipped root group, and that used to
   * mean they rendered AFTER every object in raw PDF space. Painting order
   * was decided by coordinate space, and `z` only sorted within each of
   * the two piles.
   *
   * Invisible while a patch could only ever sit on the line it replaced,
   * because nothing else was there. The moment a patch could be MOVED it
   * became: drag a line somewhere, put a text box in the same spot, and
   * the text box is behind it whatever its z -- with Bring to front unable
   * to help, because the ordering never consulted z in the first place.
   */
  describe('z order across coordinate spaces', () => {
    const patchObj = (id: string, z: number, pageId = 'p1'): EditObject => ({
      id, pageId, kind: 'textPatch',
      rect: { x: 10, y: 20, w: 100, h: 12 },
      rotation: 0, z, locked: false, opacity: 1,
      lineIndex: 0, originalHash: 'h', originalText: 'ab', text: 'ab',
      fontFamily: 'Inter', fontSize: 10, baseline: 30, color: [0, 0, 0],
      background: [1, 1, 1], backgroundConfidence: 1, fit: 'overflow',
    } as unknown as EditObject)

    const painted = (page_: PageState = page) =>
      mount(PageOverlay, { props: { page: page_, zoom: 1 } })
        .findAll('[data-object-id]')
        .map((n) => n.attributes('data-object-id'))

    it('paints a drawn object above a patch it was placed over', () => {
      const s = useEditsStore()
      s.applyOp({ type: 'addObject', object: patchObj('patch', 1) }, 'add')
      s.applyOp({ type: 'addObject', object: obj('mine', 'p1', 2) }, 'add')
      expect(painted()).toEqual(['patch', 'mine'])
    })

    it('paints a patch above a drawn object with a lower z', () => {
      const s = useEditsStore()
      s.applyOp({ type: 'addObject', object: obj('mine', 'p1', 1) }, 'add')
      s.applyOp({ type: 'addObject', object: patchObj('patch', 2) }, 'add')
      expect(painted()).toEqual(['mine', 'patch'])
    })

    it('interleaves more than two, in one order for the whole page', () => {
      const s = useEditsStore()
      s.applyOp({ type: 'addObject', object: patchObj('p-lo', 1) }, 'add')
      s.applyOp({ type: 'addObject', object: obj('o-mid', 'p1', 2) }, 'add')
      s.applyOp({ type: 'addObject', object: patchObj('p-hi', 3) }, 'add')
      s.applyOp({ type: 'addObject', object: obj('o-top', 'p1', 4) }, 'add')
      expect(painted()).toEqual(['p-lo', 'o-mid', 'p-hi', 'o-top'])
    })

    /**
     * The reason the two spaces were separated in the first place, and it
     * has to survive: a page-space object inside the y-flipped group lands
     * at the mirror image of where it belongs.
     */
    it('gives the page transform to raw-PDF objects and to no others', () => {
      const s = useEditsStore()
      s.applyOp({ type: 'addObject', object: patchObj('patch', 1) }, 'add')
      s.applyOp({ type: 'addObject', object: obj('mine', 'p1', 2) }, 'add')
      const w = mount(PageOverlay, { props: { page, zoom: 1 } })
      const transformOf = (id: string) =>
        w.get(`[data-object-id="${id}"]`).element.parentElement?.getAttribute('transform')
      expect(transformOf('mine')).toContain('scale(1 -1)')
      expect(transformOf('patch')).toBeFalsy()
    })

    /**
     * Split across two runs by a patch between them, on a quarter-turned
     * page so the transform is a non-trivial string. Both raw-PDF objects
     * must still carry exactly the same one -- a transform computed per
     * group is a transform that can differ per group.
     */
    it('gives every raw-PDF object the SAME transform, not one computed per group', () => {
      const s = useEditsStore()
      s.applyOp({ type: 'addObject', object: obj('a', 'p2', 1) }, 'add')
      s.applyOp({ type: 'addObject', object: patchObj('patch', 2, 'p2') }, 'add')
      s.applyOp({ type: 'addObject', object: obj('b', 'p2', 3) }, 'add')
      const w = mount(PageOverlay, { props: { page: turned, zoom: 1 } })
      const transformOf = (id: string) =>
        w.get(`[data-object-id="${id}"]`).element.parentElement?.getAttribute('transform')
      expect(transformOf('a')).toContain('rotate(90)')
      expect(transformOf('b')).toBe(transformOf('a'))
    })
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
