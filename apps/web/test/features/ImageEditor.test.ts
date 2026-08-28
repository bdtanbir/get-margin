import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import ImageEditor from '@/features/patch/ImageEditor.vue'
import { useEditsStore } from '@/stores/edits'
import { useViewportStore } from '@/stores/viewport'
import type { ImagePatchObject, PageImageIndex } from '@margin/pdf-core'
import type { PageState } from '@/stores/document'

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

beforeEach(() => { setActivePinia(createPinia()) })

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

  it('scales the targets with the zoom', () => {
    seed()
    const first = mount(ImageEditor, { props: { page, zoom: 2, index: INDEX } })
      .find('[data-image-target="0"]')
    expect(first.attributes('style')).toContain('left: 100px')
    expect(first.attributes('style')).toContain('width: 400px')
  })

  it('covers the image that was clicked', async () => {
    const edits = seed()
    await mountIt().find('[data-image-target="0"]').trigger('click')
    expect(patches(edits)).toHaveLength(1)
    expect(patches(edits)[0]!.imageIndex).toBe(0)
  })

  /**
   * The guard the writer relies on. Without the hash taken at edit time the
   * refusal at export is circular -- it would be comparing the page to
   * itself rather than to what the user was looking at.
   */
  it('records the placement hash the writer will check against', async () => {
    const edits = seed()
    await mountIt().find('[data-image-target="1"]').trigger('click')
    expect(patches(edits)[0]!.originalHash).toBe('bbbb2222')
  })

  it('stores the image box as the patch rect, in page space', async () => {
    const edits = seed()
    await mountIt().find('[data-image-target="0"]').trigger('click')
    expect(patches(edits)[0]!.rect).toEqual({ x: 50, y: 50, w: 200, h: 100 })
  })

  it('is a toggle: clicking a covered image brings it back', async () => {
    const edits = seed()
    const editor = mountIt()
    await editor.find('[data-image-target="0"]').trigger('click')
    expect(patches(edits)).toHaveLength(1)
    await editor.find('[data-image-target="0"]').trigger('click')
    expect(patches(edits)).toHaveLength(0)
  })

  it('covers one image without touching the other', async () => {
    const edits = seed()
    const editor = mountIt()
    await editor.find('[data-image-target="0"]').trigger('click')
    await editor.find('[data-image-target="1"]').trigger('click')
    expect(patches(edits).map((p) => p.imageIndex).sort()).toEqual([0, 1])
  })

  it('says in its label which state a target is in', async () => {
    seed()
    const editor = mountIt()
    const target = editor.find('[data-image-target="0"]')
    expect(target.attributes('aria-label')).toBe('Remove image 1')
    expect(target.attributes('aria-pressed')).toBe('false')
    await target.trigger('click')
    expect(editor.find('[data-image-target="0"]').attributes('aria-label'))
      .toBe('Bring back image 1')
    expect(editor.find('[data-image-target="0"]').attributes('aria-pressed')).toBe('true')
  })

  it('each removal is one undoable step', async () => {
    const edits = seed()
    const editor = mountIt()
    await editor.find('[data-image-target="0"]').trigger('click')
    edits.undo()
    expect(patches(edits)).toHaveLength(0)
    edits.redo()
    expect(patches(edits)).toHaveLength(1)
  })

  /**
   * With no page bitmap to sample there is nothing to be confident about,
   * and white is the honest default -- the same answer `sampleBackground`
   * gives when it is handed nothing.
   */
  it('falls back to white when there is no rendered page to sample', async () => {
    const edits = seed()
    await mountIt().find('[data-image-target="0"]').trigger('click')
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

    await mountIt().find('[data-image-target="0"]').trigger('click')
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

    await mountIt().find('[data-image-target="0"]').trigger('click')
    expect(patches(edits)[0]!.background).toEqual([1, 1, 1])
    expect(patches(edits)[0]!.backgroundConfidence).toBeGreaterThan(0.9)
  })
})
