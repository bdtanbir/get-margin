import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import LiftTool from '@/features/patch/LiftTool.vue'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { useViewportStore } from '@/stores/viewport'
import type { RegionPatchObject } from '@margin/pdf-core'
import type { PageState } from '@/stores/document'

const regionCrop = vi.fn<(...args: unknown[]) => Promise<{ data: Uint8Array } | undefined>>()
vi.mock('@/workers/pdfClient', () => ({
  getPdfClient: () => ({ regionCrop }),
  closeSharedDocument: vi.fn(),
}))

const page: PageState = {
  id: 'p1', sourceId: 'src-0', sourceIndex: 0,
  geometry: { cropBox: [0, 0, 612, 792], rotate: 0 },
}

function seed() {
  const edits = useEditsStore()
  edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
    { p1: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null } })
  return edits
}

const mountIt = (zoom = 1) => mount(LiftTool, { props: { page, zoom } })

const patches = (edits: ReturnType<typeof useEditsStore>): RegionPatchObject[] =>
  Object.values(edits.doc.objects).filter((o): o is RegionPatchObject => o.kind === 'regionPatch')

function movePointer(x: number, y: number): void {
  const e = new Event('pointermove', { bubbles: true }) as PointerEvent
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1 })
  window.dispatchEvent(e)
}

function releasePointer(): void {
  const e = new Event('pointerup', { bubbles: true }) as PointerEvent
  Object.assign(e, { clientX: 0, clientY: 0, pointerId: 1 })
  window.dispatchEvent(e)
}

/** Drag a box from (x0,y0) to (x1,y1) in view pixels. */
async function dragBox(
  w: ReturnType<typeof mountIt>,
  x0: number, y0: number, x1: number, y1: number,
): Promise<void> {
  await w.find('[data-lift-surface]')
    .trigger('pointerdown', { button: 0, clientX: x0, clientY: y0, pointerId: 1 })
  movePointer(x1, y1)
  await flushPromises()
  releasePointer()
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  regionCrop.mockReset()
  regionCrop.mockResolvedValue({ data: new Uint8Array([9, 8, 7]) })
})

describe('LiftTool', () => {
  it('shows the box while it is being drawn', async () => {
    seed()
    const w = mountIt()
    await w.find('[data-lift-surface]')
      .trigger('pointerdown', { button: 0, clientX: 50, clientY: 60, pointerId: 1 })
    movePointer(150, 160)
    await flushPromises()
    const draft = w.find('[data-lift-draft]')
    expect(draft.exists()).toBe(true)
    expect(draft.attributes('style')).toContain('left: 50px')
    expect(draft.attributes('style')).toContain('width: 100px')
  })

  it('takes the box down again once the drag ends', async () => {
    seed()
    const w = mountIt()
    await dragBox(w, 50, 60, 150, 160)
    expect(w.find('[data-lift-draft]').exists()).toBe(false)
  })

  it('lifts the area that was drawn', async () => {
    const edits = seed()
    await dragBox(mountIt(), 50, 60, 150, 160)
    expect(patches(edits)).toHaveLength(1)
    expect(patches(edits)[0]!.rect).toEqual({ x: 50, y: 60, w: 100, h: 100 })
  })

  /** Dragging up-and-left is the same box as dragging down-and-right. */
  it('normalises a box drawn backwards', async () => {
    const edits = seed()
    await dragBox(mountIt(), 150, 160, 50, 60)
    expect(patches(edits)[0]!.rect).toEqual({ x: 50, y: 60, w: 100, h: 100 })
  })

  it('converts the box out of view pixels at the current zoom', async () => {
    const edits = seed()
    await dragBox(mountIt(2), 100, 120, 300, 320)
    expect(patches(edits)[0]!.rect).toEqual({ x: 50, y: 60, w: 100, h: 100 })
  })

  it('carries a raster of the area', async () => {
    const edits = seed()
    await dragBox(mountIt(), 50, 60, 150, 160)
    expect(patches(edits)[0]!.data).toEqual(new Uint8Array([9, 8, 7]))
    expect(patches(edits)[0]!.mime).toBe('image/png')
  })

  it('asks the worker for exactly the area drawn', async () => {
    seed()
    await dragBox(mountIt(), 50, 60, 150, 160)
    expect(regionCrop).toHaveBeenCalledWith('src-0', 0, { x: 50, y: 60, w: 100, h: 100 }, 4)
  })

  /**
   * A press that barely travelled is a click on the page, not a lift. An
   * object six points across is one the user cannot see, cannot find, and
   * did not ask for.
   */
  it('ignores a box too small to be meant', async () => {
    const edits = seed()
    await dragBox(mountIt(), 50, 60, 53, 63)
    expect(patches(edits)).toHaveLength(0)
    expect(regionCrop).not.toHaveBeenCalled()
  })

  /**
   * Covering the area and drawing nothing back would read as a deletion
   * the user did not ask for.
   *
   * Asserts the OUTCOME the user can see -- nothing lifted, and the tool
   * still theirs -- rather than the mechanism. A guarded return and a
   * thrown error both leave no object behind, so the handover below is
   * what separates "declined cleanly" from "fell over".
   */
  it('does nothing when the crop cannot be produced', async () => {
    const edits = seed()
    const tools = useToolsStore()
    tools.setTool('lift')
    regionCrop.mockResolvedValue(undefined)
    await dragBox(mountIt(), 50, 60, 150, 160)
    expect(patches(edits)).toHaveLength(0)
    expect(tools.active).toBe('lift')
  })

  it('is still usable after a crop it could not produce', async () => {
    const edits = seed()
    regionCrop.mockResolvedValueOnce(undefined)
    const w = mountIt()
    await dragBox(w, 50, 60, 150, 160)
    await dragBox(w, 200, 200, 300, 300)
    expect(patches(edits)).toHaveLength(1)
    expect(patches(edits)[0]!.rect).toEqual({ x: 200, y: 200, w: 100, h: 100 })
  })

  /**
   * The next thing anybody does after lifting something is move it, and
   * moving is the select tool's gesture.
   */
  it('hands over the select tool with the new piece selected', async () => {
    const edits = seed()
    const tools = useToolsStore()
    tools.setTool('lift')
    await dragBox(mountIt(), 50, 60, 150, 160)
    expect(tools.active).toBe('select')
    expect(edits.selection).toEqual([patches(edits)[0]!.id])
  })

  it('is one undoable step', async () => {
    const edits = seed()
    await dragBox(mountIt(), 50, 60, 150, 160)
    while (edits.canUndo) edits.undo()
    expect(patches(edits)).toHaveLength(0)
  })

  it('samples the colour behind the area from the rendered page', async () => {
    const edits = seed()
    const width = 612, height = 792
    const rgba = new Uint8Array(width * height * 4)
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 200; rgba[i + 1] = 200; rgba[i + 2] = 200; rgba[i + 3] = 255
    }
    vi.spyOn(useViewportStore(), 'bitmapFor')
      .mockReturnValue({ width, height, rgba, scale: 1 } as never)

    await dragBox(mountIt(), 50, 60, 150, 160)
    const [r] = patches(edits)[0]!.background
    expect(r).toBeCloseTo(200 / 255, 2)
    expect(patches(edits)[0]!.backgroundConfidence).toBeGreaterThan(0.9)
  })

  it('falls back to white when there is no rendered page to sample', async () => {
    const edits = seed()
    await dragBox(mountIt(), 50, 60, 150, 160)
    expect(patches(edits)[0]!.background).toEqual([1, 1, 1])
  })

  it('ignores a press from a non-primary button', async () => {
    const edits = seed()
    await mountIt().find('[data-lift-surface]')
      .trigger('pointerdown', { button: 2, clientX: 50, clientY: 60, pointerId: 1 })
    movePointer(150, 160)
    releasePointer()
    await flushPromises()
    expect(patches(edits)).toHaveLength(0)
  })
})
