import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import LayersPanel from '@/features/layers/LayersPanel.vue'
import { useEditsStore } from '@/stores/edits'
import { useViewportStore } from '@/stores/viewport'
import { seedDocument } from '../helpers/seedDocument'
import type { EditObject } from '@margin/pdf-core'

vi.mock('../../src/workers/pdfClient.js', () => ({
  getPdfClient: () => ({
    open: vi.fn(), authenticate: vi.fn(), render: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined), terminate: vi.fn(),
  }),
}))

const base = { rotation: 0, locked: false, opacity: 1 }

const text = {
  ...base, id: 'text-1', pageId: 'p1', kind: 'text', z: 1,
  rect: { x: 100, y: 200, w: 80, h: 40 },
  text: 'custom text added', fontFamily: 'Inter', fontSize: 14,
  color: [0, 0, 0], align: 'left',
} as unknown as EditObject

const image = {
  ...base, id: 'image-1', pageId: 'p1', kind: 'image', z: 2,
  rect: { x: 10, y: 10, w: 100, h: 100 },
  data: new Uint8Array([1]), mime: 'image/png',
} as unknown as EditObject

const signature = {
  ...base, id: 'sig-1', pageId: 'p2', kind: 'signature', z: 3,
  rect: { x: 0, y: 0, w: 50, h: 20 },
  data: new Uint8Array([1]), mime: 'image/png',
} as unknown as EditObject

/**
 * An edited line. Its rect is the replaced line's own box in MuPDF PAGE
 * space (top-down), unlike every other object's bottom-up rect -- 600 from
 * the TOP of a 792pt page, i.e. near the bottom of the sheet.
 */
const patch = {
  ...base, id: 'patch-1', pageId: 'p1', kind: 'textPatch', z: 4,
  rect: { x: 100, y: 600, w: 80, h: 12 },
  lineIndex: 3, originalHash: 'h', originalText: 'Total Amount', text: 'Total TK',
  fontFamily: 'Helvetica', fontSize: 0, color: [0, 0, 0], background: [1, 1, 1],
  backgroundConfidence: 1, fit: 'shrink',
} as unknown as EditObject

describe('LayersPanel', () => {
  let edits: ReturnType<typeof useEditsStore>
  let vp: ReturnType<typeof useViewportStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    vp = useViewportStore()
    seedDocument([{ id: 'p1', sourceIndex: 0 }, { id: 'p2', sourceIndex: 1 }])
  })

  function add(...objects: EditObject[]): void {
    for (const o of objects) edits.applyOp({ type: 'addObject', object: o }, 'add')
  }

  const rows = (w: ReturnType<typeof mount>) => w.findAll('[data-layer-row]')

  it('invites the user to add something when the document is untouched', () => {
    const w = mount(LayersPanel)
    expect(w.find('[data-layers-empty]').exists()).toBe(true)
    expect(rows(w)).toHaveLength(0)
  })

  it('lists every object the user has added', () => {
    add(text, image, signature)
    const w = mount(LayersPanel)
    expect(rows(w).map((r) => r.attributes('data-layer-row'))).toEqual(
      ['image-1', 'text-1', 'sig-1'],
    )
  })

  // Grouped by page and in document order, because "which page is that on"
  // is the first thing you ask of a list spanning a document.
  it('groups the list by page, in document order', () => {
    add(text, image, signature)
    const w = mount(LayersPanel)
    expect(w.findAll('[data-layer-group]').map((g) => g.text())).toEqual(['Page 1', 'Page 2'])
  })

  // Top-most first, the way every design tool stacks a layer list: the
  // object drawn over the others is the one at the top of the list.
  it('puts the topmost object first within a page', () => {
    add(text, image)
    const w = mount(LayersPanel)
    expect(rows(w).map((r) => r.attributes('data-layer-row'))).toEqual(['image-1', 'text-1'])
  })

  it('labels a row with what the object says', () => {
    add(text)
    const w = mount(LayersPanel)
    expect(rows(w)[0]!.text()).toContain('custom text added')
  })

  it('selects the object when its row is clicked', async () => {
    add(text, image)
    const w = mount(LayersPanel)
    await rows(w)[1]!.trigger('click')
    expect(edits.selection).toEqual(['text-1'])
  })

  /**
   * The point of the list: clicking a row takes you to the object. The
   * offset is the object's own top in view pixels -- 792pt page, a rect
   * 200pt up from the bottom and 40pt tall, at zoom 1.
   */
  it('scrolls to the object, not just to its page', async () => {
    add(text, signature)
    const w = mount(LayersPanel)
    await rows(w)[0]!.trigger('click')
    expect(vp.scrollRequest).toMatchObject({ index: 0, offset: 552 })
  })

  it('scrolls to the page the object is on', async () => {
    add(text, signature)
    const w = mount(LayersPanel)
    await rows(w)[1]!.trigger('click')
    expect(vp.scrollRequest?.index).toBe(1)
  })

  /**
   * The bug this pins: a patch's rect is page space, and reading it as PDF
   * space scrolled to 792 - 600 - 12 = 180 -- the mirror image of the line,
   * near the TOP of the page, for a line near the bottom.
   */
  it('scrolls to an edited line where the line actually is', async () => {
    add(patch)
    const w = mount(LayersPanel)
    await rows(w)[0]!.trigger('click')
    expect(vp.scrollRequest).toMatchObject({ index: 0, offset: 600 })
  })

  it('marks the selected object row as current', async () => {
    add(text, image)
    edits.select(['text-1'])
    const w = mount(LayersPanel)
    const row = rows(w).find((r) => r.attributes('data-layer-row') === 'text-1')
    expect(row?.attributes('aria-current')).toBe('true')
  })

  it('deletes the object from its row', async () => {
    add(text, image)
    const w = mount(LayersPanel)
    await w.find('[data-layer-delete="text-1"]').trigger('click')
    expect(edits.doc.objects['text-1']).toBeUndefined()
    expect(edits.doc.objects['image-1']).toBeDefined()
  })

  // Deleting is not selecting: the row's button must not drag the viewport
  // to an object that is about to stop existing.
  it('does not select or scroll when the delete button is clicked', async () => {
    add(text)
    const w = mount(LayersPanel)
    await w.find('[data-layer-delete="text-1"]').trigger('click')
    expect(edits.selection).toEqual([])
    expect(vp.scrollRequest).toBeNull()
  })
})
