import { describe, it, expect, beforeEach } from 'vitest'
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
