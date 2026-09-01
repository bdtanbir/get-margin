import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import ImageEditor from '@/features/patch/ImageEditor.vue'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { useViewportStore } from '@/stores/viewport'
import type { ImagePatchObject, PageImageIndex } from '@margin/pdf-core'
import type { PageState } from '@/stores/document'

const imageCrop = vi.fn<
  (...args: unknown[]) => Promise<{ data: Uint8Array; hash: string } | undefined>
>()
vi.mock('@/workers/pdfClient', () => ({
  getPdfClient: () => ({ imageCrop }),
  closeSharedDocument: vi.fn(),
}))

const page: PageState = {
  id: 'p1', sourceId: 'src-0', sourceIndex: 0,
  geometry: { cropBox: [0, 0, 612, 792], rotate: 0 },
}

/** Two images: one at 50,50..250,150 and one at 300,400..380,480. */
const INDEX: PageImageIndex = {
  images: [
    { index: 0, bbox: [50, 50, 250, 150], width: 800, height: 400, hash: 'aaaa1111' },
    { index: 1, bbox: [300, 400, 380, 480], width: 200, height: 200, hash: 'bbbb2222' },
  ],
}

function seed() {
  const edits = useEditsStore()
  edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
    { p1: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null } })
  return edits
}

const mountIt = (index: PageImageIndex | undefined = INDEX) =>
  mount(ImageEditor, { props: { page, zoom: 1, index } })

const patches = (edits: ReturnType<typeof useEditsStore>): ImagePatchObject[] =>
  Object.values(edits.doc.objects).filter((o): o is ImagePatchObject => o.kind === 'imagePatch')

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

/** Press and release without travelling: the gesture that removes. */
async function click(editor: ReturnType<typeof mountIt>, index: number): Promise<void> {
  await editor.find(`[data-image-target="${index}"]`)
    .trigger('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1 })
  releasePointer()
  await flushPromises()
}

/** Press, travel to (x, y), release: the gesture that moves. */
async function drag(
  editor: ReturnType<typeof mountIt>, index: number, x: number, y: number,
): Promise<void> {
  await editor.find(`[data-image-target="${index}"]`)
    .trigger('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1 })
  movePointer(x, y)
  await flushPromises()
  movePointer(x, y)
  releasePointer()
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  imageCrop.mockReset()
  imageCrop.mockResolvedValue({ data: new Uint8Array([1, 2, 3]), hash: 'aaaa1111' })
})

describe('ImageEditor', () => {
  it('offers one target per image the page draws', () => {
    seed()
    expect(mountIt().findAll('[data-image-target]')).toHaveLength(2)
  })

  it('draws nothing when the page has no images', () => {
    seed()
    expect(mountIt({ images: [] }).findAll('[data-image-target]')).toHaveLength(0)
  })

  it('puts each target over the image it covers, in view pixels', () => {
    seed()
    const first = mountIt().find('[data-image-target="0"]')
    expect(first.attributes('style')).toContain('left: 50px')
    expect(first.attributes('style')).toContain('top: 50px')
    expect(first.attributes('style')).toContain('width: 200px')
    expect(first.attributes('style')).toContain('height: 100px')
  })

  /**
   * A TARGET HAS TO BE WHERE THE THING IS.
   *
   * The same bug `PatchEditor` already carries a paragraph about: its line
   * targets used to stay behind at the empty space a moved line had left,
   * so the text the user could see had no target and clicking where it was
   * grabbed nothing. This tool had it too -- move the logo to the middle of
   * the page, come back to the tool, and the outline is still sitting on
   * the blank rectangle the logo used to occupy.
   */
  describe('once an image has been moved', () => {
    const moved = (offset: { dx: number; dy: number }) => {
      const edits = useEditsStore()
      edits.applyOp({
        type: 'addObject',
        object: {
          id: 'ip1', pageId: 'p1', kind: 'imagePatch',
          imageIndex: 0, originalHash: 'aaaa1111',
          background: [1, 1, 1], backgroundConfidence: 1,
          data: new Uint8Array([1, 2, 3]), mime: 'image/png',
          offset,
          rect: { x: 50, y: 50, w: 200, h: 100 },
          rotation: 0, z: 1, locked: false, opacity: 1,
        } as never,
      }, 'add')
      return edits
    }

    it('its target follows it', () => {
      seed()
      moved({ dx: 60, dy: 40 })
      const target = mountIt().find('[data-image-target="0"]')
      expect(target.attributes('style')).toContain('left: 110px')
      expect(target.attributes('style')).toContain('top: 90px')
    })

    it('and is still the size of the image', () => {
      seed()
      moved({ dx: 60, dy: 40 })
      const target = mountIt().find('[data-image-target="0"]')
      expect(target.attributes('style')).toContain('width: 200px')
      expect(target.attributes('style')).toContain('height: 100px')
    })

    it('the move scales with the zoom like everything else', () => {
      seed()
      moved({ dx: 60, dy: 40 })
      const target = mount(ImageEditor, { props: { page, zoom: 2, index: INDEX } })
        .find('[data-image-target="0"]')
      expect(target.attributes('style')).toContain('left: 220px')
    })

    it('a resized image gets a target its own size', () => {
      seed()
      const edits = useEditsStore()
      edits.applyOp({
        type: 'addObject',
        object: {
          id: 'ip2', pageId: 'p1', kind: 'imagePatch',
          imageIndex: 0, originalHash: 'aaaa1111',
          background: [1, 1, 1], backgroundConfidence: 1,
          data: new Uint8Array([1]), mime: 'image/png',
          size: { w: 60, h: 30 }, offset: { dx: 10, dy: 5 },
          rect: { x: 50, y: 50, w: 200, h: 100 },
          rotation: 0, z: 1, locked: false, opacity: 1,
        } as never,
      }, 'add')
      const target = mountIt().find('[data-image-target="0"]')
      expect(target.attributes('style')).toContain('width: 60px')
      expect(target.attributes('style')).toContain('height: 30px')
      expect(target.attributes('style')).toContain('left: 60px')
    })

    it('clicking it selects the image it has become, not a second copy', async () => {
      const edits = seed()
      moved({ dx: 60, dy: 40 })
      await click(mountIt(), 0)
      expect(patches(edits)).toHaveLength(1)
      expect(edits.selection).toEqual(['ip1'])
    })

    /** An untouched image has nowhere else to be. */
    it('leaves an image that has not moved where it is', () => {
      seed()
      const target = mountIt().find('[data-image-target="0"]')
      expect(target.attributes('style')).toContain('left: 50px')
      expect(target.attributes('style')).toContain('top: 50px')
    })
  })

  it('scales the targets with the zoom', () => {
    seed()
    const first = mount(ImageEditor, { props: { page, zoom: 2, index: INDEX } })
      .find('[data-image-target="0"]')
    expect(first.attributes('style')).toContain('left: 100px')
    expect(first.attributes('style')).toContain('width: 400px')
  })

  it('picks up the image that was clicked', async () => {
    const edits = seed()
    await click(mountIt(), 0)
    expect(patches(edits)).toHaveLength(1)
    expect(patches(edits)[0]!.imageIndex).toBe(0)
  })

  /**
   * A click LIFTS, it does not remove. Removing on a single click destroyed
   * something with no confirmation and no visible way back, and left the
   * user unable to reach the ordinary object controls -- duplicate, order,
   * lock, delete -- that everything else on the page has.
   */
  it('leaves the image exactly where it was, carrying a copy of itself', async () => {
    const edits = seed()
    await click(mountIt(), 0)
    expect(patches(edits)[0]!.data).toEqual(new Uint8Array([1, 2, 3]))
    expect(patches(edits)[0]!.offset).toBeUndefined()
  })

  /**
   * The whole point of the change: the selection toolbar is what carries
   * duplicate, order, lock and delete, and it only appears for a selected
   * object under the select tool.
   */
  it('hands over the select tool with the image selected', async () => {
    const edits = seed()
    const tools = useToolsStore()
    tools.setTool('editImage')
    await click(mountIt(), 0)
    expect(tools.active).toBe('select')
    expect(edits.selection).toEqual([patches(edits)[0]!.id])
  })

  /**
   * The guard the writer relies on. Without the hash taken at edit time the
   * refusal at export is circular -- it would be comparing the page to
   * itself rather than to what the user was looking at.
   */
  it('records the placement hash the writer will check against', async () => {
    const edits = seed()
    await click(mountIt(), 1)
    expect(patches(edits)[0]!.originalHash).toBe('bbbb2222')
  })

  it('stores the image box as the patch rect, in page space', async () => {
    const edits = seed()
    await click(mountIt(), 0)
    expect(patches(edits)[0]!.rect).toEqual({ x: 50, y: 50, w: 200, h: 100 })
  })

  it('selects the image again rather than picking up a second copy', async () => {
    const edits = seed()
    const editor = mountIt()
    await click(editor, 0)
    const first = patches(edits)[0]!.id
    await click(editor, 0)
    expect(patches(edits)).toHaveLength(1)
    expect(edits.selection).toEqual([first])
  })

  it('picks up one image without touching the other', async () => {
    const edits = seed()
    const editor = mountIt()
    await click(editor, 0)
    await click(editor, 1)
    expect(patches(edits).map((p) => p.imageIndex).sort()).toEqual([0, 1])
  })

  it('says what a target does', () => {
    seed()
    const target = mountIt().find('[data-image-target="0"]')
    expect(target.attributes('aria-label')).toBe('Select image 1')
    expect(target.attributes('title')).toContain('Click to select')
  })

  it('each removal is one undoable step', async () => {
    const edits = seed()
    const editor = mountIt()
    await click(editor, 0)
    edits.undo()
    expect(patches(edits)).toHaveLength(0)
    edits.redo()
    expect(patches(edits)).toHaveLength(1)
  })

  describe('dragging', () => {
    it('lifts the image and gives its patch a raster of itself', async () => {
      const edits = seed()
      await drag(mountIt(), 0, 60, 40)
      expect(patches(edits)).toHaveLength(1)
      expect(patches(edits)[0]!.data).toEqual(new Uint8Array([1, 2, 3]))
      expect(patches(edits)[0]!.mime).toBe('image/png')
    })

    it('records how far it was dragged, in points', async () => {
      const edits = seed()
      await drag(mountIt(), 0, 60, 40)
      expect(patches(edits)[0]!.offset).toEqual({ dx: 60, dy: 40 })
    })

    it('converts the drag out of view pixels at the current zoom', async () => {
      const edits = seed()
      const editor = mount(ImageEditor, { props: { page, zoom: 2, index: INDEX } })
      await drag(editor, 0, 60, 40)
      // 60 view pixels at 2x is 30 points.
      expect(patches(edits)[0]!.offset).toEqual({ dx: 30, dy: 20 })
    })

    it('asks for the crop at the image\'s own pixel density', async () => {
      seed()
      // Image 0 is 800px wide in 200pt: 4x oversampled.
      await drag(mountIt(), 0, 60, 40)
      expect(imageCrop).toHaveBeenCalledWith('src-0', 0, 0, 4)
    })

    it('clamps the crop scale for an image with little detail to keep', async () => {
      seed()
      // Image 1 is 200px in 80pt: 2.5x, ceilinged to 3.
      await drag(mountIt(), 1, 60, 40)
      expect(imageCrop).toHaveBeenCalledWith('src-0', 0, 1, 3)
    })

    it('keeps the guard hash the writer will check against', async () => {
      const edits = seed()
      await drag(mountIt(), 0, 60, 40)
      expect(patches(edits)[0]!.originalHash).toBe('aaaa1111')
    })

    it('leaves the cover where the image was', async () => {
      const edits = seed()
      await drag(mountIt(), 0, 60, 40)
      // The rect is the ORIGINAL box; only the offset moves. The document's
      // own image is still under the cover, so moving it would uncover it.
      expect(patches(edits)[0]!.rect).toEqual({ x: 50, y: 50, w: 200, h: 100 })
    })

    it('moves an image that was already picked up, without adding a second patch', async () => {
      const edits = seed()
      const editor = mountIt()
      await click(editor, 0)
      expect(patches(edits)).toHaveLength(1)
      await drag(editor, 0, 60, 40)
      expect(patches(edits)).toHaveLength(1)
      expect(patches(edits)[0]!.offset).toEqual({ dx: 60, dy: 40 })
    })

    it('hands over the select tool once the drag ends', async () => {
      const edits = seed()
      const tools = useToolsStore()
      tools.setTool('editImage')
      await drag(mountIt(), 0, 60, 40)
      expect(tools.active).toBe('select')
      expect(edits.selection).toEqual([patches(edits)[0]!.id])
    })

    it('accumulates a second drag onto the first', async () => {
      const edits = seed()
      const editor = mountIt()
      await drag(editor, 0, 60, 40)
      await drag(editor, 0, 10, 5)
      expect(patches(edits)[0]!.offset).toEqual({ dx: 70, dy: 45 })
    })

    /**
     * Below the threshold the gesture is a click, and a click removes. A
     * one-pixel wobble on a trackpad must not leave the user with an image
     * they did not mean to lift.
     */
    it('treats a press that barely moves as a click', async () => {
      const edits = seed()
      await drag(mountIt(), 0, 2, 1)
      expect(patches(edits)).toHaveLength(1)
      // Picked up in place, not dragged: a trackpad wobble is not a move.
      expect(patches(edits)[0]!.offset).toBeUndefined()
    })

    /**
     * A crop that cannot be produced must move NOTHING. Covering the image
     * and drawing no copy would read as a delete the user did not ask for.
     */
    it('does nothing when the crop cannot be produced', async () => {
      const edits = seed()
      imageCrop.mockResolvedValue(undefined)
      await drag(mountIt(), 0, 60, 40)
      expect(patches(edits)).toHaveLength(0)
    })

    it('ignores a press from a non-primary button', async () => {
      const edits = seed()
      await mountIt().find('[data-image-target="0"]')
        .trigger('pointerdown', { button: 2, clientX: 0, clientY: 0, pointerId: 1 })
      releasePointer()
      await flushPromises()
      expect(patches(edits)).toHaveLength(0)
    })

    it('a move is one undoable step back to where it started', async () => {
      const edits = seed()
      await drag(mountIt(), 0, 60, 40)
      while (edits.canUndo) edits.undo()
      expect(patches(edits)).toHaveLength(0)
    })
  })

  /**
   * With no page bitmap to sample there is nothing to be confident about,
   * and white is the honest default -- the same answer `sampleBackground`
   * gives when it is handed nothing.
   */
  it('falls back to white when there is no rendered page to sample', async () => {
    const edits = seed()
    await click(mountIt(), 0)
    expect(patches(edits)[0]!.background).toEqual([1, 1, 1])
    expect(patches(edits)[0]!.backgroundConfidence).toBe(0)
  })

  it('samples the colour behind the image from the rendered page', async () => {
    const edits = seed()
    // A page of solid mid-grey, rendered at 1x.
    const width = 612, height = 792
    const rgba = new Uint8Array(width * height * 4)
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 128; rgba[i + 1] = 128; rgba[i + 2] = 128; rgba[i + 3] = 255
    }
    vi.spyOn(useViewportStore(), 'bitmapFor')
      .mockReturnValue({ width, height, rgba, scale: 1 } as never)

    await click(mountIt(), 0)
    const [r, g, b] = patches(edits)[0]!.background
    expect(r).toBeCloseTo(128 / 255, 2)
    expect(g).toBeCloseTo(128 / 255, 2)
    expect(b).toBeCloseTo(128 / 255, 2)
    // Flat grey is a colour a flat rectangle can imitate exactly.
    expect(patches(edits)[0]!.backgroundConfidence).toBeGreaterThan(0.9)
  })

  /**
   * The band cap, from the other end. `sampleBackground` would otherwise
   * reach a third of the box's height -- 33pt for this 100pt image -- and
   * a stripe of ink 20pt away would drag the confidence down for a cover
   * that would in fact have been invisible.
   */
  it('does not let content far from the image spoil the sample', async () => {
    const edits = seed()
    const width = 612, height = 792
    const rgba = new Uint8Array(width * height * 4).fill(255)
    // Solid black, 20pt below the image's bottom edge at y=150.
    for (let y = 170; y < 200; y++) {
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4
        rgba[at] = 0; rgba[at + 1] = 0; rgba[at + 2] = 0; rgba[at + 3] = 255
      }
    }
    vi.spyOn(useViewportStore(), 'bitmapFor')
      .mockReturnValue({ width, height, rgba, scale: 1 } as never)

    await click(mountIt(), 0)
    expect(patches(edits)[0]!.background).toEqual([1, 1, 1])
    expect(patches(edits)[0]!.backgroundConfidence).toBeGreaterThan(0.9)
  })
})

/**
 * A double-click on the page enters this tool ALREADY POINTING at an image.
 *
 * `PageOverlay` makes the request and is not mounted here: what this tool
 * owes is to honour a request addressed to its own page as soon as it can
 * see the image it names.
 */
describe('opening on request', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    imageCrop.mockReset()
    imageCrop.mockResolvedValue({ data: new Uint8Array([1, 2, 3]), hash: 'bbbb2222' })
  })

  it('lifts the requested image and hands over the select tool', async () => {
    const edits = seed()
    const tools = useToolsStore()
    tools.requestImage('p1', 1)
    mountIt()
    await flushPromises()

    expect(patches(edits)).toHaveLength(1)
    expect(patches(edits)[0]!.imageIndex).toBe(1)
    // The next thing anybody does with something they picked is act on it,
    // and every action lives on the selection toolbar.
    expect(tools.active).toBe('select')
    expect(edits.selection).toEqual([patches(edits)[0]!.id])
  })

  it('forgets the request once it has been honoured', async () => {
    seed()
    const tools = useToolsStore()
    tools.requestImage('p1', 1)
    mountIt()
    await flushPromises()
    expect(tools.pendingImage).toBeUndefined()
  })

  it('ignores a request addressed to another page', async () => {
    const edits = seed()
    useToolsStore().requestImage('p2', 1)
    mountIt()
    await flushPromises()
    expect(patches(edits)).toHaveLength(0)
  })

  it('lifts nothing at all when nothing was requested', async () => {
    const edits = seed()
    mountIt()
    await flushPromises()
    expect(patches(edits)).toHaveLength(0)
  })

  /**
   * The image index is fetched per page and may not have landed when the
   * tool switches, so a request that names an image this page cannot see
   * yet has to wait rather than be dropped.
   *
   * Mounted the long way round: `mountIt(undefined)` would trigger its
   * default parameter and quietly hand over the POPULATED index.
   */
  it('waits for the index when it has not arrived yet', async () => {
    const edits = seed()
    const tools = useToolsStore()
    tools.requestImage('p1', 1)
    const w = mount(ImageEditor, { props: { page, zoom: 1, index: undefined } })
    await flushPromises()
    expect(patches(edits)).toHaveLength(0)

    await w.setProps({ index: INDEX })
    await flushPromises()
    expect(patches(edits)).toHaveLength(1)
    expect(patches(edits)[0]!.imageIndex).toBe(1)
  })
})
