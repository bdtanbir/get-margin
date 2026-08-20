import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import PageGrid from '@/features/pages/PageGrid.vue'
import { useEditsStore } from '@/stores/edits'

import { seedPages } from '../helpers/seedDocument'

describe('PageGrid', () => {
  let edits: ReturnType<typeof useEditsStore>

  // Wrappers are unmounted by enableAutoUnmount in test/setup.ts. That is
  // load-bearing here: usePageSelection keeps module-scope state, so a
  // surviving component from an earlier test would go on handling clicks
  // against that test's store.
  const grid = () => mount(PageGrid)

  beforeEach(() => {
    setActivePinia(createPinia())
    seedPages(4)
    edits = useEditsStore()
  })

  const tile = (w: ReturnType<typeof mount>, i: number) => w.get(`[data-page-tile="p${i}"]`)

  it('renders one tile per page in display order', () => {
    const w = grid()
    const ids = w.findAll('[data-page-tile]').map((t) => t.attributes('data-page-tile'))
    expect(ids).toEqual(['p0', 'p1', 'p2', 'p3'])
  })

  it('follows a reorder', async () => {
    edits.applyOp({ type: 'reorderPages', pageOrder: ['p3', 'p0', 'p1', 'p2'] }, 'Reorder')
    const w = grid()
    const ids = w.findAll('[data-page-tile]').map((t) => t.attributes('data-page-tile'))
    expect(ids).toEqual(['p3', 'p0', 'p1', 'p2'])
  })

  it('selects a single page on click', async () => {
    const w = grid()
    await tile(w, 1).trigger('click')
    expect(tile(w, 1).attributes('aria-selected')).toBe('true')
    expect(tile(w, 0).attributes('aria-selected')).toBe('false')
  })

  it('adds to the selection with ctrl-click', async () => {
    const w = grid()
    await tile(w, 0).trigger('click')
    await tile(w, 2).trigger('click', { ctrlKey: true })
    expect(w.findAll('[aria-selected="true"]')).toHaveLength(2)
  })

  it('removes from the selection with a second ctrl-click', async () => {
    const w = grid()
    await tile(w, 0).trigger('click')
    await tile(w, 2).trigger('click', { ctrlKey: true })
    await tile(w, 2).trigger('click', { ctrlKey: true })
    expect(w.findAll('[aria-selected="true"]')).toHaveLength(1)
  })

  it('selects a range with shift-click', async () => {
    const w = grid()
    await tile(w, 0).trigger('click')
    await tile(w, 2).trigger('click', { shiftKey: true })
    expect(w.findAll('[aria-selected="true"]')).toHaveLength(3)
  })

  it('selects the same range shift-clicking backwards', async () => {
    const w = grid()
    await tile(w, 3).trigger('click')
    await tile(w, 1).trigger('click', { shiftKey: true })
    expect(w.findAll('[aria-selected="true"]')).toHaveLength(3)
  })

  // Rotating four pages is one action to the user, so it is one Ctrl+Z.
  it('rotates every selected page in one history entry', async () => {
    const w = grid()
    await tile(w, 0).trigger('click')
    await tile(w, 1).trigger('click', { ctrlKey: true })
    const before = edits.historySize
    await w.get('[data-rotate-right]').trigger('click')
    expect(edits.doc.pages.p0!.rotation).toBe(90)
    expect(edits.doc.pages.p1!.rotation).toBe(90)
    expect(edits.doc.pages.p2!.rotation).toBe(0)
    expect(edits.historySize).toBe(before + 1)
  })

  it('rotates left as 270, not -90', async () => {
    const w = grid()
    await tile(w, 0).trigger('click')
    await w.get('[data-rotate-left]').trigger('click')
    expect(edits.doc.pages.p0!.rotation).toBe(270)
  })

  it('deletes every selected page in one entry and drops them from the selection', async () => {
    const w = grid()
    await tile(w, 0).trigger('click')
    await tile(w, 1).trigger('click', { ctrlKey: true })
    const before = edits.historySize
    await w.get('[data-delete-pages]').trigger('click')
    expect(edits.doc.pageOrder).toEqual(['p2', 'p3'])
    expect(edits.historySize).toBe(before + 1)
    expect(w.findAll('[aria-selected="true"]')).toHaveLength(0)
  })

  it('offers no page actions without a selection', () => {
    const w = grid()
    expect(w.find('[data-rotate-right]').exists()).toBe(false)
    expect(w.find('[data-delete-pages]').exists()).toBe(false)
    expect(w.text()).toContain('4 pages')
  })

  it('reports how many are selected', async () => {
    const w = grid()
    await tile(w, 0).trigger('click')
    await tile(w, 1).trigger('click', { ctrlKey: true })
    expect(w.text()).toContain('2 selected')
  })

  // Rotation changes what MuPDF renders, unlike every Phase 2 edit, so the
  // page's cached bitmap has to go.
  it('invalidates the rotated pages’ bitmaps', async () => {
    const { useViewportStore } = await import('@/stores/viewport')
    const vp = useViewportStore()
    const seen: string[] = []
    const original = vp.invalidate
    vp.invalidate = ((id: string) => { seen.push(id); original(id) }) as typeof vp.invalidate
    const w = grid()
    await tile(w, 0).trigger('click')
    await w.get('[data-rotate-right]').trigger('click')
    expect(seen).toEqual(['p0'])
  })
})

// Task 47. Dragging a tile to a new position.
describe('PageGrid drag to reorder', () => {
  let edits: ReturnType<typeof useEditsStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    seedPages(4)
    edits = useEditsStore()
  })

  /** Tiles stacked 100px apart, so midpoints land at 50, 150, 250, 350. */
  function stubLayout(w: ReturnType<typeof mount>): void {
    w.findAll('[data-page-tile]').forEach((tile, i) => {
      vi.spyOn(tile.element, 'getBoundingClientRect').mockReturnValue({
        top: i * 100, height: 100, bottom: i * 100 + 100,
        left: 0, right: 200, width: 200, x: 0, y: i * 100,
        toJSON: () => ({}),
      } as DOMRect)
    })
  }

  function dragTile(w: ReturnType<typeof mount>, id: string, toY: number): void {
    const el = w.get(`[data-page-tile="${id}"]`).element
    const down = new Event('pointerdown', { bubbles: true }) as PointerEvent
    Object.assign(down, { clientX: 0, clientY: 50, pointerId: 1 })
    Object.defineProperty(down, 'currentTarget', { value: el, configurable: true })
    el.dispatchEvent(down)

    const move = new Event('pointermove', { bubbles: true }) as PointerEvent
    Object.assign(move, { clientX: 0, clientY: toY, pointerId: 1 })
    window.dispatchEvent(move)

    window.dispatchEvent(new Event('pointerup', { bubbles: true }))
  }

  it('moves a page to where it was dropped', () => {
    const w = mount(PageGrid)
    stubLayout(w)
    // Drag p0 down past the midpoint of p2 (250) -> index 3.
    dragTile(w, 'p0', 260)
    expect(edits.doc.pageOrder).toEqual(['p1', 'p2', 'p0', 'p3'])
  })

  it('moves a page to the very end', () => {
    const w = mount(PageGrid)
    stubLayout(w)
    dragTile(w, 'p0', 999)
    expect(edits.doc.pageOrder).toEqual(['p1', 'p2', 'p3', 'p0'])
  })

  it('is one history entry per drag', () => {
    const w = mount(PageGrid)
    stubLayout(w)
    const before = edits.historySize
    dragTile(w, 'p0', 260)
    expect(edits.historySize).toBe(before + 1)
  })

  // A click that does not move must not create an undo step.
  it('creates no history entry for a drag that changes nothing', () => {
    const w = mount(PageGrid)
    stubLayout(w)
    const before = edits.historySize
    dragTile(w, 'p0', 10)
    expect(edits.doc.pageOrder).toEqual(['p0', 'p1', 'p2', 'p3'])
    expect(edits.historySize).toBe(before)
  })

  it('shows a drop marker while dragging', async () => {
    const w = mount(PageGrid)
    stubLayout(w)
    const el = w.get('[data-page-tile="p0"]').element
    const down = new Event('pointerdown', { bubbles: true }) as PointerEvent
    Object.assign(down, { clientX: 0, clientY: 50, pointerId: 1 })
    Object.defineProperty(down, 'currentTarget', { value: el, configurable: true })
    el.dispatchEvent(down)
    const move = new Event('pointermove', { bubbles: true }) as PointerEvent
    Object.assign(move, { clientX: 0, clientY: 260, pointerId: 1 })
    window.dispatchEvent(move)
    await w.vm.$nextTick()
    expect(w.findAll('[data-drop-marker]').length).toBeGreaterThan(0)
    window.dispatchEvent(new Event('pointerup', { bubbles: true }))
  })

  it('never loses or duplicates a page', () => {
    const w = mount(PageGrid)
    stubLayout(w)
    dragTile(w, 'p2', 10)
    expect([...edits.doc.pageOrder].sort()).toEqual(['p0', 'p1', 'p2', 'p3'])
  })
})

// Task 64: Phase 3's recorded capability gap. On the phone the pages panel
// closes when a thumbnail is tapped, so tap-to-select was unreachable --
// the grid carrying the actions was gone by the time a selection existed.
/** Tiles stacked 100px apart, so a drag has somewhere to land. */
function stubLayoutFor(w: ReturnType<typeof mount>): void {
  w.findAll('[data-page-tile]').forEach((tile, i) => {
    vi.spyOn(tile.element, 'getBoundingClientRect').mockReturnValue({
      top: i * 100, height: 100, bottom: i * 100 + 100,
      left: 0, right: 200, width: 200, x: 0, y: i * 100,
      toJSON: () => ({}),
    } as DOMRect)
  })
}

describe('PageGrid per-tile selection control', () => {
  let edits: ReturnType<typeof useEditsStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    seedPages(4)
    edits = useEditsStore()
  })

  const selectControl = (w: ReturnType<typeof mount>, i: number) =>
    w.get(`[data-select-page="p${i}"]`)

  it('gives every tile a select control', () => {
    const w = mount(PageGrid)
    expect(w.findAll('[data-select-page]')).toHaveLength(4)
  })

  it('selects without navigating', async () => {
    const w = mount(PageGrid)
    await selectControl(w, 1).trigger('click')
    expect(w.get('[data-page-tile="p1"]').attributes('aria-selected')).toBe('true')
    // Navigation is what closes the panel on phone; it must not have happened.
    expect(w.emitted('select')).toBeUndefined()
  })

  it('toggles back off', async () => {
    const w = mount(PageGrid)
    await selectControl(w, 1).trigger('click')
    await selectControl(w, 1).trigger('click')
    expect(w.findAll('[aria-selected="true"]')).toHaveLength(0)
  })

  it('adds to the selection rather than replacing it', async () => {
    const w = mount(PageGrid)
    await selectControl(w, 0).trigger('click')
    await selectControl(w, 2).trigger('click')
    expect(w.findAll('[data-page-tile][aria-selected="true"]')).toHaveLength(2)
  })

  /**
   * The NAME and the state live on the tile, not on this control.
   *
   * The tile is a `role="option"` in a multi-select listbox, so its name
   * and `aria-selected` are what a screen reader announces. This checkbox
   * used to carry its own label and `aria-pressed` -- a second interactive
   * element inside the option, which is an axe `nested-interactive`
   * violation and produced two competing announcements for one page. It is
   * now a mouse affordance, hidden from the accessibility tree, with the
   * option's own Space key doing the same job.
   */
  it('names the tile for screen readers, by page position and state', async () => {
    const w = mount(PageGrid)
    const tile = () => w.findAll('[data-page-tile]')[0]!

    expect(tile().attributes('aria-label')).toBe('Page 1')
    expect(tile().attributes('aria-selected')).toBe('false')

    await selectControl(w, 0).trigger('click')
    expect(tile().attributes('aria-selected')).toBe('true')
  })

  /**
   * Hidden from the accessibility tree AND not focusable -- which for this
   * control means not being a button at all.
   *
   * axe's nested-interactive is explicit that a negative tabindex inside
   * an interactive control does not stop assistive technology focusing it,
   * even with aria-hidden. So `<button tabindex="-1" aria-hidden>` still
   * failed; only a non-focusable element passes.
   */
  it('is a pointer affordance, not a control in the accessibility tree', () => {
    const w = mount(PageGrid)
    expect(selectControl(w, 0).attributes('aria-hidden')).toBe('true')
    expect(selectControl(w, 0).element.tagName).toBe('SPAN')
    expect(selectControl(w, 0).attributes('tabindex')).toBeUndefined()
  })

  /**
   * The grid had no keyboard support at all: a listbox whose options were
   * not focusable, reachable only by tabbing to the buttons nested inside
   * each tile. Removing that nesting without this would have taken it from
   * badly reachable to unreachable.
   */
  describe('keyboard', () => {
    const tiles = (w: ReturnType<typeof mount>) => w.findAll('[data-page-tile]')

    it('puts exactly one tile in the tab order', () => {
      const w = mount(PageGrid)
      const tabbable = tiles(w).filter((t) => t.attributes('tabindex') === '0')
      expect(tabbable).toHaveLength(1)
    })

    it('toggles selection with Space, without navigating', async () => {
      const w = mount(PageGrid)
      await tiles(w)[1]!.trigger('keydown', { key: ' ' })
      expect(tiles(w)[1]!.attributes('aria-selected')).toBe('true')
      expect(w.emitted('select')).toBeUndefined()
    })

    it('navigates with Enter', async () => {
      const w = mount(PageGrid)
      await tiles(w)[2]!.trigger('keydown', { key: 'Enter' })
      expect(w.emitted('select')?.[0]).toEqual([2])
    })

    /** Arrows move focus without destroying a selection built up so far. */
    it('moves the roving tabindex with the arrow keys, leaving selection alone', async () => {
      const w = mount(PageGrid)
      await tiles(w)[0]!.trigger('keydown', { key: ' ' })
      await tiles(w)[0]!.trigger('keydown', { key: 'ArrowRight' })

      expect(tiles(w)[1]!.attributes('tabindex')).toBe('0')
      expect(tiles(w)[0]!.attributes('tabindex')).toBe('-1')
      expect(tiles(w)[0]!.attributes('aria-selected')).toBe('true')
    })

    it('extends the selection with Shift and an arrow', async () => {
      const w = mount(PageGrid)
      await tiles(w)[0]!.trigger('keydown', { key: ' ' })
      await tiles(w)[0]!.trigger('keydown', { key: 'ArrowRight', shiftKey: true })
      expect(w.findAll('[data-page-tile][aria-selected="true"]').length).toBeGreaterThan(1)
    })

    it('jumps to the ends with Home and End', async () => {
      const w = mount(PageGrid)
      await tiles(w)[0]!.trigger('keydown', { key: 'End' })
      expect(tiles(w).at(-1)!.attributes('tabindex')).toBe('0')
      await tiles(w).at(-1)!.trigger('keydown', { key: 'Home' })
      expect(tiles(w)[0]!.attributes('tabindex')).toBe('0')
    })
  })

  // The tile starts a reorder drag on pointerdown; without stopping it here
  // every tap of the checkbox would begin dragging the page.
  it('does not start a reorder drag', async () => {
    const w = mount(PageGrid)
    stubLayoutFor(w)
    const el = selectControl(w, 0).element
    const down = new Event('pointerdown', { bubbles: true }) as PointerEvent
    Object.assign(down, { clientX: 0, clientY: 50, pointerId: 1 })
    Object.defineProperty(down, 'currentTarget', { value: el, configurable: true })
    el.dispatchEvent(down)

    const move = new Event('pointermove', { bubbles: true }) as PointerEvent
    Object.assign(move, { clientX: 0, clientY: 400, pointerId: 1 })
    window.dispatchEvent(move)
    window.dispatchEvent(new Event('pointerup', { bubbles: true }))

    expect(edits.doc.pageOrder).toEqual(['p0', 'p1', 'p2', 'p3'])
  })

  it('drives the page actions', async () => {
    const w = mount(PageGrid)
    await selectControl(w, 0).trigger('click')
    await w.get('[data-rotate-right]').trigger('click')
    expect(edits.doc.pages.p0!.rotation).toBe(90)
  })
})
