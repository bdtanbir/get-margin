import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import PageList from '@/features/viewport/PageList.vue'
import { useEditsStore } from '@/stores/edits'
import { seedPages } from '../helpers/seedDocument'
import type { EditObject } from '@margin/pdf-core'

vi.mock('../../src/workers/pdfClient.js', () => ({
  getPdfClient: () => ({
    open: vi.fn(), authenticate: vi.fn(), render: vi.fn().mockResolvedValue(undefined),
    quadIndex: vi.fn().mockResolvedValue({ lines: [] }),
    close: vi.fn().mockResolvedValue(undefined), terminate: vi.fn(),
  }),
}))

const rect = {
  id: 'r1', pageId: 'p0', kind: 'rect', z: 1,
  rect: { x: 10, y: 20, w: 100, h: 50 },
  rotation: 0, locked: false, opacity: 1,
  stroke: [0, 0, 0], strokeWidth: 1, fill: null,
} as unknown as EditObject

/**
 * "Click somewhere else to deselect" -- the rule every editor has, and the
 * one this app was missing: a layer picked in the Layers panel stayed
 * selected (with its whole inspector open) no matter where on the document
 * the next click landed. Only the panel's own back arrow or switching tools
 * put it away.
 */
describe('clicking away from an object', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    seedPages(1)
  })

  it('clears the selection when the pointer lands on bare canvas', async () => {
    const edits = useEditsStore()
    edits.applyOp({ type: 'addObject', object: rect }, 'Draw')
    edits.select([rect.id])

    const w = mount(PageList)
    await w.find('[role="region"]').trigger('pointerdown')

    expect(edits.selection).toEqual([])
  })

  it('leaves the selection alone when the pointer lands on an object', async () => {
    const edits = useEditsStore()
    edits.applyOp({ type: 'addObject', object: rect }, 'Draw')
    edits.select([rect.id])

    const w = mount(PageList, { attachTo: document.body })
    // The object's own <g> carries data-object-id and selects on
    // pointerdown; the event still bubbles to the scroller, which must not
    // undo the selection it just made.
    const scroller = w.find('[role="region"]').element
    const object = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    object.setAttribute('data-object-id', rect.id)
    scroller.appendChild(object)
    object.dispatchEvent(new Event('pointerdown', { bubbles: true }))

    expect(edits.selection).toEqual([rect.id])
    w.unmount()
  })
})
