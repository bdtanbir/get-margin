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
function indexOf(
  text: string,
  bold = false,
  color: Color = [0, 0, 0],
  italic = false,
): PageQuadIndex {
  return {
    lines: [{
      bbox: [40, 100, 160, 118],
      text,
      font: 'Test',
      bold,
      italic,
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

  /**
   * Issue reported from an iPhone in dark mode: tapping a line to edit it
   * produced black text on a black field, unreadable.
   *
   * The field's colour was already taken from the LINE (a grey label types
   * in grey, even in dark mode) but its background was `bg-surface` -- an
   * app theme token, near-black under a dark theme. The page underneath is
   * white paper whatever the interface is wearing, so the field has to be
   * painted with the page, not with the chrome.
   */
  it('paints the field with the page behind it, not the app theme', async () => {
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')

    const input = w.get('[data-patch-input]').element as HTMLInputElement
    expect(input.style.backgroundColor).toBe('rgb(255, 255, 255)')
    // Not merely "some inline colour": the theme token must be gone, or a
    // dark theme would still win wherever the inline value is absent.
    expect(w.get('[data-patch-input]').classes()).not.toContain('bg-surface')
  })

  it('follows the page colour rather than assuming white paper', async () => {
    // A flat grey page, the colour the committed patch would paint.
    const grey = flatBitmap()
    grey.rgba.fill(200)
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(grey)

    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')

    const input = w.get('[data-patch-input]').element as HTMLInputElement
    expect(input.style.backgroundColor).toBe('rgb(200, 200, 200)')
  })

  /**
   * Second half of the same report: tapping a line threw the viewport to a
   * random magnification. That is iOS zooming the page because the field it
   * focused draws below 16px -- the fixture line is 12pt at zoom 1.
   *
   * The field asks for 16px and is scaled back down by the same factor, so
   * iOS has nothing to correct and the text still draws at 12px.
   */
  it('gives iOS no reason to zoom, without drawing the text any larger', async () => {
    const w = mountEditor(INDEX)
    await w.get('[data-patch-target="0"]').trigger('click')

    const input = w.get('[data-patch-input]').element as HTMLInputElement
    expect(Number.parseFloat(input.style.fontSize)).toBeGreaterThanOrEqual(16)
    // 12px asked for, 16px declared, so the element is drawn at 0.75.
    expect(input.style.transform).toContain('scale(0.75)')
    // Scaling from the top-left keeps the field over the line it replaces;
    // the default centre origin would slide it up and to the left.
    expect(input.style.transformOrigin).toBe('top left')
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

  /**
   * Editing a line that has been DRAGGED away from where the document put
   * it.
   *
   * Everything in this editor is positioned from `lineBox`, which is the
   * line's box in the SOURCE -- the box the cover is painted over, and
   * after a move no longer the box the text is in. So the field, the fit
   * guide and the click target all stayed behind at the empty space the
   * line had left, while the text the user could see had no target at all.
   */
  describe('a line that has been moved', () => {
    const OFFSET = { dx: 200, dy: 60 }

    /** The patch the Move button leaves behind: unchanged but relocated. */
    const moved = (over: Partial<TextPatchObject> = {}): TextPatchObject => ({
      id: 'tp1', pageId: 'p1', kind: 'textPatch',
      lineIndex: 0,
      originalHash: hashText('Original line'),
      originalText: 'Original line',
      text: 'Original line',
      fontFamily: 'Inter', bold: false, italic: false, fontSize: 12, baseline: 114,
      color: [0, 0, 0], background: [1, 1, 1], backgroundConfidence: 1,
      fit: 'overflow',
      rect: { x: 40, y: 100, w: 120, h: 18 },
      offset: OFFSET,
      rotation: 0, z: 1, locked: false, opacity: 1,
      ...over,
    })

    const withMoved = (over: Partial<TextPatchObject> = {}) => {
      const edits = seed()
      vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
      edits.applyOp({ type: 'addObject', object: moved(over) as never }, 'add')
      return { edits, w: mountEditor(INDEX) }
    }

    it('puts the click target on the moved text, not on the space it left', () => {
      const { w } = withMoved()
      const target = w.get('[data-patch-target="0"]').attributes('style')
      // The line sits at x 40, y 100; moved, it is at 240, 160.
      expect(target).toContain('left: 240px')
      expect(target).toContain('top: 160px')
    })

    it('opens the field where the text is now', async () => {
      const { w } = withMoved()
      await w.get('[data-patch-target="0"]').trigger('click')
      const style = w.get('[data-patch-input]').attributes('style')
      expect(style).toContain('left: 240px')
      expect(style).toContain('top: 160px')
    })

    /**
     * THE DATA-LOSS BUG. A moved-but-unedited patch has the line's own
     * words and the line's own style, so the "they typed the original
     * back, undo the edit" test matched it -- and merely opening the field
     * and clicking away deleted the move. The line snapped back to where
     * the document had it and the user's work was gone, with nothing on
     * screen to say why.
     */
    it('does not discard the move when the field is closed unchanged', async () => {
      const { edits, w } = withMoved()
      await w.get('[data-patch-target="0"]').trigger('click')
      await w.get('[data-patch-input]').trigger('keydown.enter')
      expect(patches(edits)).toHaveLength(1)
      expect(patches(edits)[0]!.offset).toEqual(OFFSET)
    })

    it('does not discard it on blur either, which is the commoner way out', async () => {
      const { edits, w } = withMoved()
      await w.get('[data-patch-target="0"]').trigger('click')
      await w.get('[data-patch-input]').trigger('blur')
      expect(patches(edits)).toHaveLength(1)
    })

    it('keeps the move when the text is edited', async () => {
      const { edits, w } = withMoved()
      await w.get('[data-patch-target="0"]').trigger('click')
      await w.get('[data-patch-input]').setValue('Retyped')
      await w.get('[data-patch-input]').trigger('keydown.enter')
      expect(patches(edits)[0]!.text).toBe('Retyped')
      expect(patches(edits)[0]!.offset).toEqual(OFFSET)
    })

    /**
     * The guide marks where the original line ended, which is what the fit
     * rules measure against -- and a moved patch always overflows, because
     * it is no longer in that box. Drawing it would claim a constraint
     * that has stopped applying, at a position the text is not at.
     */
    it('hides the fit guide, which describes a box the text has left', async () => {
      const { w } = withMoved()
      await w.get('[data-patch-target="0"]').trigger('click')
      expect(w.find('[data-patch-guide]').exists()).toBe(false)
    })

    /** An unmoved line keeps every one of those behaviours. */
    it('leaves an unmoved line exactly as it was', async () => {
      const { w } = withMoved({ offset: { dx: 0, dy: 0 } })
      const target = w.get('[data-patch-target="0"]').attributes('style')
      expect(target).toContain('left: 40px')
      await w.get('[data-patch-target="0"]').trigger('click')
      expect(w.get('[data-patch-input]').attributes('style')).toContain('left: 40px')
      expect(w.find('[data-patch-guide]').exists()).toBe(true)
    })

    it('still undoes the edit when an unmoved patch is typed back', async () => {
      const { edits, w } = withMoved({ offset: { dx: 0, dy: 0 }, text: 'Changed' })
      await w.get('[data-patch-target="0"]').trigger('click')
      await w.get('[data-patch-input]').setValue('Original line')
      await w.get('[data-patch-input]').trigger('keydown.enter')
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
    //
    // Read as declared-size x scale rather than off `font-size` alone: the
    // field declares 16px and is scaled back down, so that iOS has no
    // reason to zoom the page (lib/textFieldZoom.ts). What this test is
    // about is the size the user SEES, which is the product of the two and
    // is still the line's own 12.
    const style = (w.get('[data-patch-input]').element as HTMLInputElement).style
    const declared = Number.parseFloat(style.fontSize)
    const scale = Number(/scale\(([\d.]+)\)/.exec(style.transform)?.[1] ?? 1)
    expect(declared * scale).toBeCloseTo(12, 6)
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

/**
 * Slope.
 *
 * The last of the four axes a patch inherits. Same shape as the others:
 * MuPDF reports `isItalic()` per run, the patch seeds from it, and the
 * inspector overrides it afterwards.
 */
describe('slope', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    missingGlyphs.mockResolvedValue([])
    seed()
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
  })

  const italicIndex = (text: string) => indexOf(text, false, [0, 0, 0], true)

  const commit = async (w: ReturnType<typeof mountEditor>, text: string) => {
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue(text)
    await w.get('[data-patch-input]').trigger('blur')
    await flushPromises()
  }

  it('keeps an italic line italic when it is edited', async () => {
    const edits = useEditsStore()
    await commit(mountEditor(italicIndex('Emphasised')), 'Still emphasised')
    expect(patches(edits)[0]!.italic).toBe(true)
  })

  it('leaves an upright line upright', async () => {
    const edits = useEditsStore()
    await commit(mountEditor(indexOf('Body text')), 'New body text')
    expect(patches(edits)[0]!.italic).toBe(false)
  })

  it('types on the slant it will commit', async () => {
    const w = mountEditor(italicIndex('Emphasised'))
    await w.get('[data-patch-target="0"]').trigger('click')
    expect(w.get('[data-patch-input]').attributes('style')).toContain('font-style: italic')
  })

  it('lets Ctrl+I override the inherited slope', async () => {
    const edits = useEditsStore()
    const w = mountEditor(italicIndex('Emphasised'))
    await w.get('[data-patch-target="0"]').trigger('click')
    await w.get('[data-patch-input]').setValue('Not emphasised')
    await w.get('[data-patch-input]').trigger('keydown', { key: 'i', ctrlKey: true })
    await w.get('[data-patch-input]').trigger('blur')
    await flushPromises()
    expect(patches(edits)[0]!.italic).toBe(false)
  })

  it('carries bold and italic together, not one instead of the other', async () => {
    // A bold-italic face is a fourth file, and a patch that inherited only
    // one axis would ask for a face the line was not set in.
    const edits = useEditsStore()
    await commit(mountEditor(indexOf('Bold emphasis', true, [0, 0, 0], true)), 'Rewritten')
    expect(patches(edits)[0]!.bold).toBe(true)
    expect(patches(edits)[0]!.italic).toBe(true)
  })
})

/**
 * Changing ONLY the style, and not a character of the text.
 *
 * The reported bug, and the case every style test above missed by also
 * retyping the line: `commit()` treated "the draft equals the original
 * text" as a request to undo the edit, so pressing Ctrl+B and touching
 * nothing else discarded the patch on blur. The style showed while the
 * field was open and vanished the moment it closed.
 *
 * Restoring the document's own appearance still discards the patch -- that
 * is the behaviour the shortcut exists for -- but it now takes ALL FOUR
 * axes matching, not just the text.
 */
describe('a style-only edit', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    missingGlyphs.mockResolvedValue([])
    seed()
    vi.spyOn(useViewportStore(), 'bitmapFor').mockReturnValue(flatBitmap())
  })

  /** Open the line, press the shortcuts, blur -- without retyping anything. */
  const styleOnly = async (
    index: PageQuadIndex,
    keys: Array<'b' | 'i'>,
  ) => {
    const w = mountEditor(index)
    await w.get('[data-patch-target="0"]').trigger('click')
    for (const key of keys) {
      await w.get('[data-patch-input]').trigger('keydown', { key, ctrlKey: true })
    }
    await w.get('[data-patch-input]').trigger('blur')
    await flushPromises()
    return w
  }

  it('keeps a bold-only change', async () => {
    const edits = useEditsStore()
    await styleOnly(indexOf('Project: Checkout Design'), ['b'])
    expect(patches(edits)).toHaveLength(1)
    expect(patches(edits)[0]!.bold).toBe(true)
    expect(patches(edits)[0]!.text).toBe('Project: Checkout Design')
  })

  it('keeps an italic-only change', async () => {
    const edits = useEditsStore()
    await styleOnly(indexOf('Project: Checkout Design'), ['i'])
    expect(patches(edits)).toHaveLength(1)
    expect(patches(edits)[0]!.italic).toBe(true)
  })

  it('keeps both when both are pressed', async () => {
    const edits = useEditsStore()
    await styleOnly(indexOf('Project: Checkout Design'), ['b', 'i'])
    expect(patches(edits)).toHaveLength(1)
    expect(patches(edits)[0]!.bold).toBe(true)
    expect(patches(edits)[0]!.italic).toBe(true)
  })

  it('records nothing when neither the text nor the style changed', async () => {
    // The shortcut still earns its keep: a cover painted over text
    // identical to what is underneath is a visible rectangle achieving
    // nothing.
    const edits = useEditsStore()
    await styleOnly(indexOf('Project: Checkout Design'), [])
    expect(patches(edits)).toHaveLength(0)
  })

  it('discards the patch when the style is toggled back to the document’s', async () => {
    const edits = useEditsStore()
    await styleOnly(indexOf('Project: Checkout Design'), ['b'])
    expect(patches(edits)).toHaveLength(1)
    await styleOnly(indexOf('Project: Checkout Design'), ['b'])
    expect(patches(edits)).toHaveLength(0)
  })

  it('keeps an un-bold of a line the document set bold', async () => {
    // The mirror image: the line is bold in the document and the user turns
    // it off. The draft still equals the original text, and this is still a
    // real edit.
    const edits = useEditsStore()
    await styleOnly(indexOf('Bold heading', true), ['b'])
    expect(patches(edits)).toHaveLength(1)
    expect(patches(edits)[0]!.bold).toBe(false)
  })
})
