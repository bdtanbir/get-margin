import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import Thumbnail from '../../src/features/document/Thumbnail.vue'

// Thumbnail reads its bitmap from the viewport store internally (its props
// are `{ page, index, active }` only, per Task 19's interface contract —
// see ThumbnailPanel.vue, which does not pass a bitmap prop either), so a
// mount needs an active Pinia even though none of the assertions below
// touch bitmap content directly.
beforeEach(() => {
  setActivePinia(createPinia())
})

const GEOM = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }
const ROTATED_GEOM = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 90 as const }
const page = { id: 'p1', sourceId: 'src-0', sourceIndex: 4, geometry: GEOM }

describe('Thumbnail', () => {
  it('labels itself with the display position, not the source index', () => {
    // Phase 3 reorders pages: display position 1 may hold source index 4.
    const w = mount(Thumbnail, { props: { page, index: 0, active: false } })
    expect(w.text()).toContain('1')
    expect(w.text()).not.toContain('5')
  })

  it('marks the active page for assistive technology', () => {
    const w = mount(Thumbnail, { props: { page, index: 0, active: true } })
    expect(w.attributes('aria-current')).toBe('true')
  })

  it('omits aria-current when inactive', () => {
    const w = mount(Thumbnail, { props: { page, index: 0, active: false } })
    expect(w.attributes('aria-current')).toBeUndefined()
  })

  it('emits select with the display index when clicked', async () => {
    const w = mount(Thumbnail, { props: { page, index: 3, active: false } })
    await w.trigger('click')
    expect(w.emitted('select')).toEqual([[3]])
  })

  it('preserves page aspect ratio in the frame', () => {
    const w = mount(Thumbnail, { props: { page, index: 0, active: false } })
    const style = w.find('[data-testid="thumb-frame"]').attributes('style') ?? ''
    expect(style).toContain('aspect-ratio')
    // 612x792 is portrait: the ratio must actually reflect that, not just
    // contain the property name with an arbitrary value.
    expect(style).toMatch(/aspect-ratio:\s*612\s*\/\s*792/)
  })

  it('swaps the aspect ratio for a rotated (landscape) page', () => {
    // A quarter-turn rotation makes a portrait page display wider than
    // tall — the frame must reflect the swapped dimensions, not the raw
    // (unrotated) cropBox order. Guards against reusing pageSizePt (which
    // ignores rotation) instead of pageViewSize.
    const rotated = { ...page, geometry: ROTATED_GEOM }
    const w = mount(Thumbnail, { props: { page: rotated, index: 0, active: false } })
    const style = w.find('[data-testid="thumb-frame"]').attributes('style') ?? ''
    expect(style).toMatch(/aspect-ratio:\s*792\s*\/\s*612/)
  })
})
