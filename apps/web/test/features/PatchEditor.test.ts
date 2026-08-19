import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import PatchEditor from '@/features/patch/PatchEditor.vue'
import { useEditsStore } from '@/stores/edits'
import { useViewportStore } from '@/stores/viewport'
import { hashText, type PageQuadIndex, type Quad, type TextPatchObject } from '@margin/pdf-core'
import type { PageState } from '@/stores/document'

const missingGlyphs = vi.fn<() => Promise<string[]>>()
vi.mock('@/workers/pdfClient', () => ({
  getPdfClient: () => ({ missingGlyphs }),
  closeSharedDocument: vi.fn(),
}))
vi.mock('@/lib/fonts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fonts')>()
  return { ...actual, fontsForExport: vi.fn(async () => new Map([['Inter', new Uint8Array([1])]])) }
})

const page: PageState = {
  id: 'p1', sourceId: 'src-0', sourceIndex: 0,
  geometry: { cropBox: [0, 0, 612, 792], rotate: 0 },
}

/** One line of text at y = 100..118, x = 40..160. */
function indexOf(text: string): PageQuadIndex {
  return {
    lines: [{
      bbox: [40, 100, 160, 118],
      text,
      font: 'Test',
      size: 12,
      chars: [...text].map((char, i) => ({
        char,
        quad: [40 + i * 10, 100, 50 + i * 10, 100, 40 + i * 10, 118, 50 + i * 10, 118] as Quad,
      })),
    }],
  }
}

const INDEX = indexOf('Original line')

function seed() {
  const edits = useEditsStore()
  edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
    { p1: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null } })
  return edits
}

/** A flat white page bitmap, so sampling is confident. */
function flatBitmap(scale = 1) {
  const width = 612 * scale
  const height = 792 * scale
  const rgba = new Uint8Array(width * height * 4).fill(255)
  return { width, height, rgba, page: 0, scale }
}

/**
 * `index` has no default: passing `undefined` explicitly would trigger a
 * default parameter and quietly mount the POPULATED index instead, which
 * is exactly how the "not extracted yet" case passed against the wrong
 * fixture.
 */
function mountEditor(index: PageQuadIndex | undefined) {
  return mount(PatchEditor, { props: { page, zoom: 1, index } })
}

const patches = (edits: ReturnType<typeof useEditsStore>): TextPatchObject[] =>
  Object.values(edits.doc.objects).filter((o): o is TextPatchObject => o.kind === 'textPatch')

describe('PatchEditor', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    missingGlyphs.mockResolvedValue([])
    seed()
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
  })

  it('offers a target for every line', () => {
    expect(mountEditor(INDEX).findAll('[data-patch-target]')).toHaveLength(1)
  })

  it('opens an input with the line’s current text selected', async () => {
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    expect((w.get('[data-patch-input]').element as HTMLInputElement).value).toBe('Original line')
  })

  it('creates a patch carrying the replacement', async () => {
    const edits = seed()
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('Replacement')
    await w.get('[data-patch-commit]').trigger('click')

    const made = patches(edits)
    expect(made).toHaveLength(1)
    expect(made[0]!.text).toBe('Replacement')
    expect(made[0]!.lineIndex).toBe(0)
  })

  /**
   * Hashed from what the USER was looking at. Hashing at export time
   * instead would make the guard circular -- it would always agree with
   * itself and catch nothing.
   */
  it('records a hash of the text as it was when edited', async () => {
    const edits = seed()
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('Replacement')
    await w.get('[data-patch-commit]').trigger('click')

    expect(patches(edits)[0]!.originalHash).toBe(hashText('Original line'))
    expect(patches(edits)[0]!.originalText).toBe('Original line')
  })

  it('records the sampled background', async () => {
    const edits = seed()
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('Replacement')
    await w.get('[data-patch-commit]').trigger('click')

    expect(patches(edits)[0]!.background).toEqual([1, 1, 1])
    expect(patches(edits)[0]!.backgroundConfidence).toBe(1)
  })

  it('creates nothing when the text is unchanged', async () => {
    const edits = seed()
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-commit]').trigger('click')
    expect(patches(edits)).toHaveLength(0)
  })

  it('abandons on cancel', async () => {
    const edits = seed()
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('Replacement')
    await w.get('[data-patch-cancel]').trigger('click')
    expect(patches(edits)).toHaveLength(0)
    expect(w.find('[data-patch-input]').exists()).toBe(false)
  })

  it('records the chosen fit', async () => {
    const edits = seed()
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('A much longer replacement')
    await w.get('[data-patch-fit]').setValue('truncate')
    await w.get('[data-patch-commit]').trigger('click')
    expect(patches(edits)[0]!.fit).toBe('truncate')
  })

  it('handles a page whose text has not been extracted yet', () => {
    expect(mountEditor(undefined).findAll('[data-patch-target]')).toHaveLength(0)
  })
})

/**
 * The warnings are the whole reason this is not just an input box. A patch
 * over a photograph works, and the flat cover shows -- finding that out in
 * the exported file is finding out too late.
 */
describe('warnings before committing', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    missingGlyphs.mockResolvedValue([])
    seed()
  })

  it('says nothing about the background when it is flat', async () => {
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    expect(w.find('[data-patch-risky]').exists()).toBe(false)
  })

  it('warns when the area behind the line is not flat', async () => {
    // Noise: a photograph, where a flat cover leaves a visible scar.
    const width = 612, height = 792
    const rgba = new Uint8Array(width * height * 4)
    let seedValue = 3
    for (let i = 0; i < rgba.length; i++) {
      seedValue = (seedValue * 1103515245 + 12345) & 0x7fffffff
      rgba[i] = (seedValue >> 8) & 0xff
    }
    vi.spyOn(useViewportStore(), 'bitmapFor')
      .mockReturnValue({ width, height, rgba, page: 0, scale: 1 })

    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    expect(w.get('[data-patch-risky]').text()).toMatch(/not a flat colour/i)
  })

  it('warns when the page has not rendered, so nothing could be sampled', async () => {
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(undefined)
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    // Zero confidence is not "flat white"; it is "unknown", and the user
    // should be told rather than shown a guess.
    expect(w.find('[data-patch-risky]').exists()).toBe(true)
  })

  /**
   * MuPDF returns .notdef rather than failing, so without this the patch
   * silently becomes a row of empty boxes -- discovered after export.
   */
  it('names characters the font cannot draw', async () => {
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
    missingGlyphs.mockResolvedValue(['A', 'B'])
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('something')
    await flushPromises()
    expect(w.get('[data-patch-missing]').text()).toContain('A B')
  })

  it('says nothing when every character can be drawn', async () => {
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('plain text')
    await flushPromises()
    expect(w.find('[data-patch-missing]').exists()).toBe(false)
  })

  it('does not block the edit when the font cannot be checked', async () => {
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
    missingGlyphs.mockRejectedValue(new Error('no font'))
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('something')
    await flushPromises()
    expect(w.find('[data-patch-missing]').exists()).toBe(false)
    expect(w.find('[data-patch-commit]').exists()).toBe(true)
  })
})
