import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SignatureModal from '@/features/signature/SignatureModal.vue'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { useDocumentStore } from '@/stores/document'
import { seedDocument } from '../helpers/seedDocument'
import * as store from '@/features/signature/signatureStore'

vi.mock('@/features/signature/signatureStore', () => ({
  listSignatures: vi.fn(async () => []),
  saveSignature: vi.fn(async () => {}),
  deleteSignature: vi.fn(async () => {}),
  clearSignatures: vi.fn(async () => {}),
}))

/**
 * Enough of a 2D context for the pad and the offscreen render. `closePath`
 * and `fill` are what perfect-freehand's outline path needs: the pad fills a
 * variable-width polygon rather than stroking a polyline (signatureImage.ts).
 */
function fakeCtx(inked: boolean) {
  return {
    clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    closePath: vi.fn(), fill: vi.fn(),
    stroke: vi.fn(), fillText: vi.fn(), drawImage: vi.fn(), putImageData: vi.fn(),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4).fill(inked ? 255 : 0),
      width: w, height: h,
    }),
    strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '', fillStyle: '',
    font: '', textBaseline: '',
  }
}

/**
 * apply() goes canvas -> toBlob -> Blob.arrayBuffer(), and jsdom resolves
 * the last of those on a macrotask. A single flushPromises() returns while
 * the chain is still pending, so the assertions would run before anything
 * had been placed.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await new Promise((r) => setTimeout(r, 0))
  }
}

function down(el: Element, x: number, y: number): void {
  const e = new Event('pointerdown', { bubbles: true }) as PointerEvent
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1 })
  el.dispatchEvent(e)
}
function move(x: number, y: number): void {
  const e = new Event('pointermove', { bubbles: true }) as PointerEvent
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1 })
  window.dispatchEvent(e)
}
function up(): void {
  window.dispatchEvent(new Event('pointerup', { bubbles: true }))
}

describe('SignatureModal', () => {
  let edits: ReturnType<typeof useEditsStore>
  let tools: ReturnType<typeof useToolsStore>
  let doc: ReturnType<typeof useDocumentStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    edits = useEditsStore()
    tools = useToolsStore()
    doc = useDocumentStore()
    seedDocument([{ id: 'p1', sourceIndex: 0 }])
    tools.setTool('signature')

    HTMLCanvasElement.prototype.getContext = vi.fn(() => fakeCtx(true)) as never
    HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
      cb(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }))
    } as never
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 600, bottom: 200, width: 600, height: 200, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect)
  })

  const mountModal = () => mount(SignatureModal, { attachTo: document.body })

  function drawOnPad(w: ReturnType<typeof mountModal>): void {
    down(w.get('[data-signature-pad]').element, 10, 10)
    move(100, 60)
    move(200, 40)
    up()
  }

  it('offers draw, type, and upload', () => {
    const w = mountModal()
    for (const t of ['draw', 'type', 'upload']) {
      expect(w.find(`[data-tab="${t}"]`).exists()).toBe(true)
    }
  })

  // Spec 2.1: a signature is sensitive, and someone signing on a borrowed
  // machine must not silently leave it in that browser's storage.
  it('leaves "save on this device" unchecked by default', () => {
    const box = mountModal().get('[data-signature-remember]').element as HTMLInputElement
    expect(box.checked).toBe(false)
  })

  it('says storage is local to this device', () => {
    expect(mountModal().text()).toContain('on this device')
  })

  it('places a drawn signature as a signature object', async () => {
    const w = mountModal()
    drawOnPad(w)
    await w.get('[data-signature-apply]').trigger('click')
    await settle()
    const objects = Object.values(edits.doc.objects)
    expect(objects).toHaveLength(1)
    expect(objects[0]).toMatchObject({ kind: 'signature', mime: 'image/png' })
  })

  it('does NOT persist the signature unless the box is checked', async () => {
    const w = mountModal()
    drawOnPad(w)
    await w.get('[data-signature-apply]').trigger('click')
    await settle()
    expect(store.saveSignature).not.toHaveBeenCalled()
  })

  it('persists only when the box is checked', async () => {
    const w = mountModal()
    await w.get('[data-signature-remember]').setValue(true)
    drawOnPad(w)
    await w.get('[data-signature-apply]').trigger('click')
    await settle()
    expect(store.saveSignature).toHaveBeenCalledTimes(1)
  })

  it('refuses an empty pad with a message rather than placing nothing', async () => {
    const w = mountModal()
    await w.get('[data-signature-apply]').trigger('click')
    await settle()
    expect(Object.keys(edits.doc.objects)).toHaveLength(0)
    expect(doc.error).toMatch(/Draw, type, or upload/)
  })

  it('places a typed signature', async () => {
    const w = mountModal()
    await w.get('[data-tab="type"]').trigger('click')
    await w.get('[data-signature-typed]').setValue('Ada Lovelace')
    await w.get('[data-signature-apply]').trigger('click')
    await settle()
    expect(Object.values(edits.doc.objects)[0]).toMatchObject({ kind: 'signature' })
  })

  it('closes back to the select tool after placing', async () => {
    const w = mountModal()
    drawOnPad(w)
    await w.get('[data-signature-apply]').trigger('click')
    await settle()
    expect(tools.active).toBe('select')
  })

  it('selects what it placed', async () => {
    const w = mountModal()
    drawOnPad(w)
    await w.get('[data-signature-apply]').trigger('click')
    await settle()
    expect(edits.selection).toEqual([Object.keys(edits.doc.objects)[0]])
  })

  it('is one undo step', async () => {
    const w = mountModal()
    drawOnPad(w)
    await w.get('[data-signature-apply]').trigger('click')
    await settle()
    expect(edits.historySize).toBe(1)
  })
})
