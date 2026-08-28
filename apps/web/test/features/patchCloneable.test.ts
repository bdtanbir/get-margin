import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { ref } from 'vue'
import PatchEditor from '@/features/patch/PatchEditor.vue'
import LiftTool from '@/features/patch/LiftTool.vue'
import ImageEditor from '@/features/patch/ImageEditor.vue'
import SelectionToolbar from '@/features/tools/SelectionToolbar.vue'
import { useEditsStore } from '@/stores/edits'
import { useViewportStore } from '@/stores/viewport'
import { useSelectionStore } from '@/stores/selection'
import type { Color, PageImageIndex, PageQuadIndex, Quad } from '@margin/pdf-core'
import type { PageState } from '@/stores/document'

const missingGlyphs = vi.fn<() => Promise<string[]>>()
const regionCrop = vi.fn<(...a: unknown[]) => Promise<{ data: Uint8Array } | undefined>>()
const imageCrop = vi.fn<(...a: unknown[]) => Promise<{ data: Uint8Array; hash: string } | undefined>>()
vi.mock('@/workers/pdfClient', () => ({
  getPdfClient: () => ({
    missingGlyphs, regionCrop, imageCrop,
    open: vi.fn(), render: vi.fn(), close: vi.fn(),
  }),
  closeSharedDocument: vi.fn(),
}))
vi.mock('@/lib/fonts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fonts')>()
  return { ...actual, fontsForExport: vi.fn(async () => new Map()) }
})

const page: PageState = {
  id: 'p1', sourceId: 'src-0', sourceIndex: 0,
  geometry: { cropBox: [0, 0, 612, 792], rotate: 0 },
}

function plainIndex(text = 'Issue Date'): PageQuadIndex {
  return {
    lines: [{
      bbox: [40, 100, 160, 118],
      text,
      font: 'Test',
      bold: false,
      italic: false,
      color: [0.42, 0.45, 0.5] as Color,
      size: 12,
      baseline: 114,
      chars: [...text].map((char, i) => ({
        char,
        quad: [40 + i * 10, 100, 50 + i * 10, 100, 40 + i * 10, 118, 50 + i * 10, 118] as Quad,
      })),
    }],
  }
}

/**
 * The index AS THE APP HOLDS IT.
 *
 * `PageOverlay` keeps it in a plain `ref()` and the selection store does
 * the same, and a `ref` holding an object makes that object DEEPLY
 * REACTIVE -- every nested array inside it is a Proxy. That is the whole
 * point of this file: the other patch tests hand the components a plain
 * object literal, so nothing in them can ever observe what the real app
 * passes.
 */
function reactiveIndex(text = 'Issue Date'): PageQuadIndex {
  return ref(plainIndex(text)).value
}

function flatBitmap() {
  const width = 612, height = 792
  return { width, height, rgba: new Uint8Array(width * height * 4).fill(255), page: 0, scale: 1 }
}

/**
 * The edit document has to survive `structuredClone`.
 *
 * It is handed to the worker by `postMessage` -- see `PdfClient.save`,
 * which notes it is structure-cloned rather than transferred -- and a
 * reactive Proxy anywhere inside it fails that with "Proxy object could not
 * be cloned". The Download button reports it and no file is produced.
 */
const expectCloneable = (value: unknown): void => {
  expect(() => structuredClone(value)).not.toThrow()
}

describe('an edit document is always structure-cloneable', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    missingGlyphs.mockResolvedValue([])
    regionCrop.mockResolvedValue({ data: new Uint8Array([1, 2, 3]) })
    imageCrop.mockResolvedValue({ data: new Uint8Array([1, 2, 3]), hash: 'aaaa1111' })
    const edits = useEditsStore()
    edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
      { p1: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null } })
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
  })

  it('after the inline editor patches a line', async () => {
    const edits = useEditsStore()
    const w = mount(PatchEditor, { props: { page, zoom: 1, index: reactiveIndex() } })
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('Issue Date nice')
    await w.get('[data-patch-input]').trigger('blur')
    await flushPromises()
    expectCloneable(edits.doc)
  })

  it('after a style-only edit, which inherits the line’s colour untouched', async () => {
    const edits = useEditsStore()
    const w = mount(PatchEditor, { props: { page, zoom: 1, index: reactiveIndex() } })
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').trigger('keydown', { key: 'b', ctrlKey: true })
    await w.get('[data-patch-input]').trigger('blur')
    await flushPromises()
    expectCloneable(edits.doc)
  })

  it('after the selection toolbar bolds a line', async () => {
    const edits = useEditsStore()
    const selection = useSelectionStore()
    selection.begin('p1', reactiveIndex(), { line: 0, char: 0 })
    selection.extend({ line: 0, char: 5 })
    const w = mount(SelectionToolbar, { props: { page, zoom: 1 } })
    await w.get('[data-style-bold]').trigger('click')
    expectCloneable(edits.doc)
  })

  /**
   * RE-EDITING one, which takes the `updateObject` path rather than
   * `addObject` and so does not go through `buildLinePatch` at all.
   *
   * Worth its own case because the obvious fix -- copying the colour where
   * it is seeded -- does nothing for it. The colour lives in a `ref`, and a
   * ref holding an array hands back a reactive Proxy on every read
   * regardless of what was assigned, so the copy has to happen where the
   * value enters the document.
   */
  it('after a line that was already patched is edited again', async () => {
    const edits = useEditsStore()
    const index = reactiveIndex()
    const w = mount(PatchEditor, { props: { page, zoom: 1, index } })

    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('First edit')
    await w.get('[data-patch-input]').trigger('blur')
    await flushPromises()

    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('Second edit')
    await w.get('[data-patch-input]').trigger('blur')
    await flushPromises()

    expect(Object.values(edits.doc.objects)).toHaveLength(1)
    expectCloneable(edits.doc)
  })

  /**
   * THE REGION HANDED TO THE WORKER, not only the document.
   *
   * `LiftTool` keeps the box it is drawing in a `ref`, and a ref holding an
   * object hands back a deeply reactive Proxy on every read. That Proxy
   * went two places: into `regionCrop`, which is a comlink call and so a
   * `postMessage`, and onto the object as its `rect`. The first threw
   * "Proxy object could not be cloned" the moment the drag ended -- before
   * anything was lifted at all -- and the second would have failed the
   * export later.
   */
  describe('after an area is lifted', () => {
    const drawBox = async (w: ReturnType<typeof mount>) => {
      await w.get('[data-lift-surface]')
        .trigger('pointerdown', { button: 0, clientX: 40, clientY: 50, pointerId: 1 })
      const move = new Event('pointermove', { bubbles: true }) as PointerEvent
      Object.assign(move, { clientX: 200, clientY: 180, pointerId: 1 })
      window.dispatchEvent(move)
      await flushPromises()
      const up = new Event('pointerup', { bubbles: true }) as PointerEvent
      Object.assign(up, { clientX: 200, clientY: 180, pointerId: 1 })
      window.dispatchEvent(up)
      await flushPromises()
    }

    it('the box sent to the worker survives postMessage', async () => {
      await drawBox(mount(LiftTool, { props: { page, zoom: 1 } }))
      expect(regionCrop).toHaveBeenCalled()
      expectCloneable(regionCrop.mock.calls[0]![2])
    })

    it('and the document it produces does too', async () => {
      const edits = useEditsStore()
      await drawBox(mount(LiftTool, { props: { page, zoom: 1 } }))
      expectCloneable(edits.doc)
    })
  })

  /**
   * The image tool reads its geometry out of an index the app holds in a
   * `ref`, so every `bbox` it touches is a Proxy over an array.
   */
  describe('after one of the document’s own images is edited', () => {
    const reactiveImages = (): PageImageIndex => ref({
      images: [{
        index: 0,
        bbox: [50, 50, 250, 150] as [number, number, number, number],
        width: 800, height: 400, hash: 'aaaa1111',
      }],
    }).value

    const press = async (w: ReturnType<typeof mount>, travel: boolean) => {
      await w.get('[data-image-target="0"]')
        .trigger('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1 })
      if (travel) {
        const move = new Event('pointermove', { bubbles: true }) as PointerEvent
        Object.assign(move, { clientX: 60, clientY: 40, pointerId: 1 })
        window.dispatchEvent(move)
        await flushPromises()
      }
      const up = new Event('pointerup', { bubbles: true }) as PointerEvent
      Object.assign(up, { clientX: 0, clientY: 0, pointerId: 1 })
      window.dispatchEvent(up)
      await flushPromises()
    }

    it('after it is removed', async () => {
      const edits = useEditsStore()
      await press(mount(ImageEditor, { props: { page, zoom: 1, index: reactiveImages() } }), false)
      expectCloneable(edits.doc)
    })

    it('after it is moved', async () => {
      const edits = useEditsStore()
      await press(mount(ImageEditor, { props: { page, zoom: 1, index: reactiveImages() } }), true)
      expectCloneable(edits.doc)
    })
  })
})
