import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import CropOverlay from '@/features/pages/CropOverlay.vue'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { seedPages } from '../helpers/seedDocument'

/**
 * Async because the Crop button is `:disabled` until a box exists, and
 * trigger('click') on a still-disabled button is a silent no-op. The tick
 * lets the box reach the DOM before the caller clicks.
 */
async function drag(
  w: ReturnType<typeof mount>,
  from: [number, number],
  to: [number, number],
): Promise<void> {
  const el = w.get('[data-crop-surface]').element
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, right: 612, bottom: 792, width: 612, height: 792, x: 0, y: 0, toJSON: () => ({}) }),
    configurable: true,
  })
  const down = new Event('pointerdown', { bubbles: true }) as PointerEvent
  Object.assign(down, { clientX: from[0], clientY: from[1], pointerId: 1 })
  Object.defineProperty(down, 'currentTarget', { value: el, configurable: true })
  el.dispatchEvent(down)

  const move = new Event('pointermove', { bubbles: true }) as PointerEvent
  Object.assign(move, { clientX: to[0], clientY: to[1], pointerId: 1 })
  window.dispatchEvent(move)

  window.dispatchEvent(new Event('pointerup', { bubbles: true }))
  await w.vm.$nextTick()
}

describe('CropOverlay', () => {
  let edits: ReturnType<typeof useEditsStore>
  let doc: ReturnType<typeof useDocumentStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    seedPages(3)
    edits = useEditsStore()
    doc = useDocumentStore()
    useToolsStore().setTool('crop')
  })

  const overlay = () =>
    mount(CropOverlay, { props: { page: doc.pages.p0!, zoom: 1 } })

  it('commits the dragged rect in raw PDF space', async () => {
    const w = overlay()
    // View y 100..300 on a 792pt page -> PDF y 492..692, because view space
    // is y-down and PDF space is y-up.
    await drag(w, [50, 100], [250, 300])
    await w.get('[data-crop-apply]').trigger('click')
    expect(edits.doc.pages.p0!.cropBox).toEqual([50, 492, 250, 692])
  })

  it('crops only the current page by default', async () => {
    const w = overlay()
    await drag(w, [50, 100], [250, 300])
    await w.get('[data-crop-apply]').trigger('click')
    expect(edits.doc.pages.p1!.cropBox).toBeNull()
  })

  it('applies to every page in one history entry', async () => {
    const w = overlay()
    await drag(w, [50, 100], [250, 300])
    await w.get('[data-crop-all]').setValue(true)
    const before = edits.historySize
    await w.get('[data-crop-apply]').trigger('click')
    expect(edits.historySize).toBe(before + 1)
    expect(edits.doc.pages.p1!.cropBox).not.toBeNull()
    expect(edits.doc.pages.p2!.cropBox).not.toBeNull()
  })

  it('commits nothing on cancel', async () => {
    const w = overlay()
    await drag(w, [50, 100], [250, 300])
    await w.get('[data-crop-cancel]').trigger('click')
    expect(edits.doc.pages.p0!.cropBox).toBeNull()
    expect(edits.historySize).toBe(0)
  })

  it('returns to the select tool after applying', async () => {
    const w = overlay()
    await drag(w, [50, 100], [250, 300])
    await w.get('[data-crop-apply]').trigger('click')
    expect(useToolsStore().active).toBe('select')
  })

  it('discards a stray click rather than cropping to nothing', async () => {
    const w = overlay()
    await drag(w, [50, 100], [52, 102])
    expect(w.find('[data-crop-box]').exists()).toBe(false)
    expect((w.get('[data-crop-apply]').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('removes an existing crop', async () => {
    edits.applyOp({ type: 'cropPage', pageId: 'p0', cropBox: { x: 0, y: 0, w: 100, h: 100 } }, 'Crop')
    const w = overlay()
    await w.get('[data-crop-clear]').trigger('click')
    expect(edits.doc.pages.p0!.cropBox).toBeNull()
  })

  // Crop hides; it does not delete. Same honesty rule as whiteout: someone
  // cropping a statement to hide an account number must not think it is gone.
  it('says the hidden content is still in the file', () => {
    expect(overlay().text()).toContain('still in the file')
  })

  it('says any PDF tool can bring it back', () => {
    expect(overlay().text()).toContain('bring it back')
  })

  it('never claims the content is removed or deleted', () => {
    const html = overlay().html().replace(/<!--[\s\S]*?-->/g, '').toLowerCase()
    expect(html).not.toContain('deletes the')
    expect(html).not.toContain('removes the content')
  })
})
