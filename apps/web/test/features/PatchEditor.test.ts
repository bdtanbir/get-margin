import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import PatchEditor from '@/features/patch/PatchEditor.vue'
import { useEditsStore } from '@/stores/edits'
import { useViewportStore } from '@/stores/viewport'
import {
  hashText, type Color, type PageQuadIndex, type Quad, type TextPatchObject,
} from '@margin/pdf-core'
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
function indexOf(text: string, bold = false, color: Color = [0, 0, 0]): PageQuadIndex {
  return {
    lines: [{
      bbox: [40, 100, 160, 118],
      text,
      font: 'Test',
      bold,
      color,
      size: 12,
      // Baseline sits above the box bottom by the font's descender.
      baseline: 114,
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

  /**
   * The field has to show what is being typed into it.
   *
   * It used to be exactly the width of the line being replaced, so typing
   * anything longer scrolled a single-line <input> and the start of the
   * user's own sentence went off the left edge while they were still
   * writing it -- replacing "Notes" with "something" showed "nething".
   */
  it('grows the field as the replacement outgrows the original line', async () => {
    const w = mountEditor(indexOf('Notes'))
    await w.get('[data-patch-target="0"]').trigger('click')

    const width = (): number =>
      Number(/width:\s*([\d.]+)px/.exec(w.get('[data-patch-input]').attributes('style') ?? '')?.[1] ?? 0)

    const before = width()
    await w.get('[data-patch-input]').setValue('something considerably longer than Notes')
    expect(width()).toBeGreaterThan(before)
  })

  it('does not shrink below the original line for a shorter replacement', async () => {
    const w = mountEditor(indexOf('A reasonably long original line'))
    await w.get('[data-patch-target="0"]').trigger('click')

    const width = (): number =>
      Number(/width:\s*([\d.]+)px/.exec(w.get('[data-patch-input]').attributes('style') ?? '')?.[1] ?? 0)

    const before = width()
    await w.get('[data-patch-input]').setValue('x')
    // Still covers the line it is replacing: that is the area being painted
    // over, and collapsing to the width of one character would hide it.
    expect(width()).toBe(before)
  })

  /**
   * The field's edge used to double as the "will it fit" mark. Now that it
   * grows, that has to be drawn explicitly or the fit setting below it
   * refers to a boundary nobody can see.
   */
  it('marks where the original line ended', async () => {
    const w = mountEditor(indexOf('Notes'))
    await w.get('[data-patch-target="0"]').trigger('click')

    // The fixture's five characters span x = 40..90, so the line is 50 wide.
    const guide = w.get('[data-patch-guide]')
    expect(guide.attributes('style')).toContain('width: 50px')
    // Decorative: the input beside it is what a screen reader should find.
    expect(guide.attributes('aria-hidden')).toBe('true')
  })

  it('creates a patch carrying the replacement', async () => {
    const edits = seed()
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('Replacement')
    await w.get('[data-patch-input]').trigger('keydown.enter')

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
    await w.get('[data-patch-input]').trigger('keydown.enter')

    expect(patches(edits)[0]!.originalHash).toBe(hashText('Original line'))
    expect(patches(edits)[0]!.originalText).toBe('Original line')
  })

  it('records the sampled background', async () => {
    const edits = seed()
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('Replacement')
    await w.get('[data-patch-input]').trigger('keydown.enter')

    expect(patches(edits)[0]!.background).toEqual([1, 1, 1])
    expect(patches(edits)[0]!.backgroundConfidence).toBe(1)
  })

  it('creates nothing when the text is unchanged', async () => {
    const edits = seed()
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').trigger('keydown.enter')
    expect(patches(edits)).toHaveLength(0)
  })

  it('abandons on cancel', async () => {
    const edits = seed()
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('Replacement')
    await w.get('[data-patch-input]').trigger('keydown.esc')
    expect(patches(edits)).toHaveLength(0)
    expect(w.find('[data-patch-input]').exists()).toBe(false)
  })

  /**
   * Typed text runs on rather than shrinking, and nothing asks about it.
   *
   * The editor used to default to shrinking and put a three-way picker in
   * front of every edit. Shrinking silently made the replacement smaller
   * than the text around it, and the picker asked a question before the
   * user had typed anything to ask it about. The writer still honours all
   * three modes -- only the control is gone.
   */
  it('lets a long replacement run, without asking', async () => {
    const edits = seed()
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')

    expect(w.find('[data-patch-fit]').exists()).toBe(false)

    await w.get('[data-patch-input]').setValue('A much longer replacement')
    await w.get('[data-patch-input]').trigger('keydown.enter')
    expect(patches(edits)[0]!.fit).toBe('overflow')
  })

  /** Clicking away is a commit, the way every inline editor behaves. */
  it('commits when the field loses focus', async () => {
    const edits = seed()
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('Committed by blurring')
    await w.get('[data-patch-input]').trigger('blur')

    expect(patches(edits)).toHaveLength(1)
    expect(patches(edits)[0]!.text).toBe('Committed by blurring')
  })

  /** Escape unmounts the field, which blurs it -- that must not commit. */
  it('does not commit the edit it just cancelled', async () => {
    const edits = seed()
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('Abandoned')
    await w.get('[data-patch-input]').trigger('keydown.esc')
    expect(patches(edits)).toHaveLength(0)
  })

  /**
   * Editing a line twice must CHANGE the edit, not add a second one.
   *
   * It used to add a second patch on the same line. Both covered it and
   * both drew their own text, so the result was two strings of glyphs
   * printed over each other -- on screen and in the exported file.
   */
  describe('editing a line that has already been edited', () => {
    async function editTwice(first: string, second: string) {
      const edits = seed()
      vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
      const w = mountEditor(INDEX)

      await w.get('[data-patch-target="0"]').trigger('click')
      await w.get('[data-patch-input]').setValue(first)
      await w.get('[data-patch-input]').trigger('keydown.enter')

      await w.get('[data-patch-target="0"]').trigger('click')
      const reopened = (w.get('[data-patch-input]').element as HTMLInputElement).value
      await w.get('[data-patch-input]').setValue(second)
      await w.get('[data-patch-input]').trigger('keydown.enter')

      return { edits, reopened }
    }

    it('reopens with what the user last typed, not the original line', async () => {
      const { reopened } = await editTwice('First replacement', 'Second replacement')
      expect(reopened).toBe('First replacement')
    })

    it('leaves exactly one patch on the line', async () => {
      const { edits } = await editTwice('First replacement', 'Second replacement')
      expect(patches(edits)).toHaveLength(1)
      expect(patches(edits)[0]!.text).toBe('Second replacement')
    })

    /**
     * The guard the writer uses describes the SOURCE line, which has not
     * changed. Recomputing it from the second edit would have it comparing
     * the edit against itself.
     */
    it('keeps the original text and hash pointing at the source document', async () => {
      const { edits } = await editTwice('First replacement', 'Second replacement')
      const patch = patches(edits)[0]!
      expect(patch.originalText).toBe('Original line')
      expect(patch.originalHash).toBe(hashText('Original line'))
    })

    /** Typing the original back is a request to undo, not to cover it with itself. */
    it('removes the patch when the original text is typed back', async () => {
      const { edits } = await editTwice('First replacement', 'Original line')
      expect(patches(edits)).toHaveLength(0)
    })
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
    // Still editable: a font that cannot be checked is not a reason to stop.
    expect(w.find('[data-patch-input]').exists()).toBe(true)
  })
})

/**
 * The reported bug, from the user's end.
 *
 * A line the DOCUMENT set in bold came back regular the moment it was
 * edited: the patch hardcoded the default face, so the one piece of
 * formatting the editor could plainly see was the one it threw away.
 * MuPDF reports the weight per run and `buildQuadIndex` carries it, so
 * there is now something to inherit -- these pin the inheritance.
 */
describe('weight', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    missingGlyphs.mockResolvedValue([])
    seed()
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
  })

  it('keeps a bold line bold when it is edited', async () => {
    const edits = useEditsStore()
    const w = mountEditor(indexOf('Bold heading', true))
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('New heading')
    await w.get('[data-patch-input]').trigger('blur')
    await flushPromises()
    expect(patches(edits)[0]!.bold).toBe(true)
  })

  it('leaves a regular line regular', async () => {
    const edits = useEditsStore()
    const w = mountEditor(indexOf('Body text'))
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('New body text')
    await w.get('[data-patch-input]').trigger('blur')
    await flushPromises()
    expect(patches(edits)[0]!.bold).toBe(false)
  })

  it('shows the inherited weight in the field being typed into', async () => {
    // The field has to look like what will be committed. Typing into a
    // regular box and getting bold on commit moves the text the user was
    // just looking at.
    const w = mountEditor(indexOf('Bold heading', true))
    await w.get('[data-patch-target="0"]').trigger('click')
    expect(w.get('[data-patch-input]').attributes('style')).toContain('font-weight: 700')
  })

  it('lets Ctrl+B override the inherited weight', async () => {
    const edits = useEditsStore()
    const w = mountEditor(indexOf('Bold heading', true))
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('New heading')
    await w.get('[data-patch-input]').trigger('keydown', { key: 'b', ctrlKey: true })
    await w.get('[data-patch-input]').trigger('blur')
    await flushPromises()
    expect(patches(edits)[0]!.bold).toBe(false)
  })

  it('resumes from the patch’s own weight when a line is edited again', async () => {
    // Not from the document's. Once the user has overridden the weight,
    // re-opening the line must not quietly undo that override.
    const edits = useEditsStore()
    const w = mountEditor(indexOf('Bold heading', true))
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('First edit')
    await w.get('[data-patch-input]').trigger('keydown', { key: 'b', ctrlKey: true })
    await w.get('[data-patch-input]').trigger('blur')
    await flushPromises()

    await w.get('[data-patch-target="0"]').trigger('click')
    expect(w.get('[data-patch-input]').attributes('style')).toContain('font-weight: 400')
    await w.get('[data-patch-input]').setValue('Second edit')
    await w.get('[data-patch-input]').trigger('blur')
    await flushPromises()
    expect(patches(edits)).toHaveLength(1)
    expect(patches(edits)[0]!.bold).toBe(false)
  })
})

/**
 * Size.
 *
 * A patch used to store `fontSize: 0` -- a sentinel meaning "work it out at
 * export from the line's own extraction". That was fine while nothing could
 * change it and useless the moment something could: an inspector cannot put
 * a number in a box when the document holds a sentinel. New patches carry
 * the real size; old ones are healed when they are re-opened.
 */
describe('size', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    missingGlyphs.mockResolvedValue([])
    seed()
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
  })

  /** The fixture's line reports size 12 and a baseline at 114. */
  const commit = async (w: ReturnType<typeof mountEditor>, text: string) => {
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue(text)
    await w.get('[data-patch-input]').trigger('blur')
    await flushPromises()
  }

  it('stores the size the line was actually set in, not a sentinel', async () => {
    const edits = useEditsStore()
    await commit(mountEditor(INDEX), 'Replacement')
    expect(patches(edits)[0]!.fontSize).toBe(12)
  })

  it('stores the line’s own baseline for the overlay to draw on', async () => {
    // Not derivable from the box: how far a baseline sits above the bottom
    // of a glyph box depends on the font's descender.
    const edits = useEditsStore()
    await commit(mountEditor(INDEX), 'Replacement')
    expect(patches(edits)[0]!.baseline).toBe(114)
  })

  it('draws the field at the line’s size rather than a fraction of its box', async () => {
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')
    // 12pt at zoom 1. The box-height approximation would give 18 * 0.8.
    expect(w.get('[data-patch-input]').attributes('style')).toContain('font-size: 12px')
  })

  it('heals a patch stored by an older build, which carries the sentinel', async () => {
    const edits = useEditsStore()
    await commit(mountEditor(INDEX), 'First edit')
    // Put the object back the way an older build would have written it.
    edits.applyOp(
      { type: 'updateObject', id: patches(edits)[0]!.id, patch: { fontSize: 0 } },
      'simulate an older build',
    )
    await commit(mountEditor(INDEX), 'Second edit')
    expect(patches(edits)).toHaveLength(1)
    expect(patches(edits)[0]!.fontSize).toBe(12)
  })

  it('keeps a size the user chose when the line is edited again', async () => {
    const edits = useEditsStore()
    await commit(mountEditor(INDEX), 'First edit')
    edits.applyOp(
      { type: 'updateObject', id: patches(edits)[0]!.id, patch: { fontSize: 20 } },
      'resize',
    )
    await commit(mountEditor(INDEX), 'Second edit')
    expect(patches(edits)[0]!.fontSize).toBe(20)
  })
})

/**
 * Colour.
 *
 * The reported bug: a grey label turned black the moment it was edited,
 * because the patch hardcoded `[0, 0, 0]`. MuPDF reports the fill per run
 * -- already converted to three channels whatever the page's own colour
 * space was -- so there is now something to inherit.
 */
describe('colour', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    missingGlyphs.mockResolvedValue([])
    seed()
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
  })

  /** The grey the fixture PDF sets its label column in. */
  const GREY: Color = [0.42, 0.45, 0.5]

  const commit = async (w: ReturnType<typeof mountEditor>, text: string) => {
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue(text)
    await w.get('[data-patch-input]').trigger('blur')
    await flushPromises()
  }

  it('keeps a grey line grey when it is edited', async () => {
    const edits = useEditsStore()
    await commit(mountEditor(indexOf('Issue Date', false, GREY)), 'Issue Date nice')
    expect(patches(edits)[0]!.color).toEqual(GREY)
  })

  it('keeps a black line black', async () => {
    const edits = useEditsStore()
    await commit(mountEditor(indexOf('Body text')), 'New body text')
    expect(patches(edits)[0]!.color).toEqual([0, 0, 0])
  })

  it('types in the line’s colour rather than the theme’s', async () => {
    // The page underneath is rendered as-is, so the field has to show the
    // document's colour -- not the UI text colour, which in dark mode is
    // close to white and would misrepresent every edit.
    const w = mountEditor(indexOf('Issue Date', false, GREY))
    await w.get('[data-patch-target="0"]').trigger('click')
    expect(w.get('[data-patch-input]').attributes('style')).toContain('color: rgb(107, 115, 128)')
  })

  it('keeps a colour the user chose when the line is edited again', async () => {
    // Inheritance is the DEFAULT, not a rule. Once the colour has been
    // overridden in the inspector, re-opening the line must not quietly
    // reset it to the document's.
    const edits = useEditsStore()
    await commit(mountEditor(indexOf('Issue Date', false, GREY)), 'First edit')
    edits.applyOp(
      { type: 'updateObject', id: patches(edits)[0]!.id, patch: { color: [1, 0, 0] } },
      'recolour',
    )
    await commit(mountEditor(indexOf('Issue Date', false, GREY)), 'Second edit')
    expect(patches(edits)).toHaveLength(1)
    expect(patches(edits)[0]!.color).toEqual([1, 0, 0])
  })
})
