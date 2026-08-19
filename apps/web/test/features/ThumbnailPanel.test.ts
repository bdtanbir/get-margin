import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import ThumbnailPanel from '../../src/features/document/ThumbnailPanel.vue'
import { useDocumentStore } from '../../src/stores/document'
import { useViewportStore } from '../../src/stores/viewport'
import { seedDocument } from '../helpers/seedDocument'

// ThumbnailPanel is the parent responsible for wiring Thumbnail's `select`
// emit to an actual viewport move, and for feeding each Thumbnail the
// store's live `anchorIndex` so the active state tracks scroll/zoom
// elsewhere in the app. A green Thumbnail suite alone cannot catch either
// wiring gap — Thumbnail only proves it EMITS `select`, not that anything
// listens.
vi.mock('../../src/workers/pdfClient.js', () => ({
  getPdfClient: () => ({
    open: vi.fn(), authenticate: vi.fn(), render: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined), terminate: vi.fn(),
  }),
}))

const GEOM = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }

function seed() {
  seedDocument(
    [
      { id: 'p0', sourceIndex: 2 },
      { id: 'p1', sourceIndex: 0 },
      { id: 'p2', sourceIndex: 1 },
    ],
    [GEOM, GEOM, GEOM],
  )
  return useDocumentStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('ThumbnailPanel', () => {
  it('renders one thumbnail per page in display order', () => {
    seed()
    const w = mount(ThumbnailPanel)
    // Three buttons, one per page in pageOrder.
    expect(w.findAll('button').length).toBe(3)
  })

  it('moves the viewport anchor when a thumbnail is clicked', async () => {
    seed()
    const vp = useViewportStore()
    const w = mount(ThumbnailPanel)
    expect(vp.anchorIndex).toBe(0)
    // Click the third thumbnail (display position 3, index 2).
    await w.findAll('button')[2]!.trigger('click')
    expect(vp.anchorIndex).toBe(2)
  })

  it('marks only the thumbnail matching the current anchor as active', async () => {
    seed()
    const vp = useViewportStore()
    vp.setAnchor(1)
    const w = mount(ThumbnailPanel)
    const buttons = w.findAll('button')
    expect(buttons[0]!.attributes('aria-current')).toBeUndefined()
    expect(buttons[1]!.attributes('aria-current')).toBe('true')
    expect(buttons[2]!.attributes('aria-current')).toBeUndefined()
  })

  it('active thumbnail tracks the anchor reactively after mount', async () => {
    seed()
    const vp = useViewportStore()
    const w = mount(ThumbnailPanel)
    vp.setAnchor(2)
    await w.vm.$nextTick()
    const buttons = w.findAll('button')
    expect(buttons[2]!.attributes('aria-current')).toBe('true')
    expect(buttons[0]!.attributes('aria-current')).toBeUndefined()
  })

  it('labels each thumbnail by display position, not source index', () => {
    // p0 has sourceIndex 2 but is first in pageOrder — must read "1", not "3".
    const doc = seed()
    expect(doc.pages.p0!.sourceIndex).toBe(2)
    const w = mount(ThumbnailPanel)
    expect(w.findAll('button')[0]!.text()).toContain('1')
  })

  it('shows the page count in the header', () => {
    seed()
    const w = mount(ThumbnailPanel)
    expect(w.text()).toContain('3 pages')
  })
})
