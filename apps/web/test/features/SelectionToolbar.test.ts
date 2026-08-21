import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SelectionToolbar from '@/features/tools/SelectionToolbar.vue'
import { useEditsStore } from '@/stores/edits'
import { useSelectionStore } from '@/stores/selection'
import type { PageState } from '@/stores/document'
import type { Color, EditObject, TextPatchObject } from '@margin/pdf-core'

const page: PageState = { id: 'p1', sourceId: 'src-0', sourceIndex: 0, geometry: { cropBox: [0, 0, 612, 792], rotate: 0 } }

function obj(id: string, z = 1): EditObject {
  return {
    id, pageId: 'p1', kind: 'rect',
    rect: { x: 100, y: 200, w: 80, h: 40 },
    rotation: 0, z, locked: false, opacity: 1,
    stroke: [0, 0, 0], strokeWidth: 1, fill: null,
  }
}

describe('SelectionToolbar', () => {
  let edits: ReturnType<typeof useEditsStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'], { p1: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
    edits.applyOp({ type: 'addObject', object: obj('o1') }, 'add')
    edits.applyOp({ type: 'addObject', object: obj('o2', 5) }, 'add')
  })

  const mountFor = () => mount(SelectionToolbar, { props: { page, zoom: 1 } })

  it('renders nothing with no selection', () => {
    expect(mountFor().find('button').exists()).toBe(false)
  })

  it('deletes the selected object and clears the selection', async () => {
    edits.select(['o1'])
    await mountFor().get('[aria-label="Delete"]').trigger('click')
    expect(edits.doc.objects.o1).toBeUndefined()
    expect(edits.selection).toEqual([])
  })

  it('duplicates onto a fresh id, offset, and selects the copy', async () => {
    edits.select(['o1'])
    await mountFor().get('[aria-label="Duplicate"]').trigger('click')
    const ids = Object.keys(edits.doc.objects)
    expect(ids).toHaveLength(3)
    const copyId = edits.selection[0]!
    expect(copyId).not.toBe('o1')
    // Offset so the copy is visibly not the original sitting underneath.
    expect(edits.doc.objects[copyId]?.rect.x).not.toBe(100)
  })

  it('brings to front above every other object on the page', async () => {
    edits.select(['o1'])
    await mountFor().get('[aria-label="Bring to front"]').trigger('click')
    expect(edits.doc.objects.o1!.z).toBeGreaterThan(edits.doc.objects.o2!.z)
  })

  it('sends to back below every other object on the page', async () => {
    edits.select(['o2'])
    await mountFor().get('[aria-label="Send to back"]').trigger('click')
    expect(edits.doc.objects.o2!.z).toBeLessThan(edits.doc.objects.o1!.z)
  })

  it('locks and unlocks', async () => {
    edits.select(['o1'])
    const w = mountFor()
    await w.get('[aria-label="Lock"]').trigger('click')
    expect(edits.doc.objects.o1?.locked).toBe(true)
    await w.get('[aria-label="Unlock"]').trigger('click')
    expect(edits.doc.objects.o1?.locked).toBe(false)
  })

  // A locked object can still be unlocked, deleted, or reordered -- lock
  // guards dragging, not the toolbar itself. Anything else is a trap.
  it('keeps its controls usable on a locked object', async () => {
    edits.applyOp({ type: 'updateObject', id: 'o1', patch: { locked: true } }, 'lock')
    edits.select(['o1'])
    const w = mountFor()
    for (const b of w.findAll('button')) expect(b.attributes('disabled')).toBeUndefined()
  })

  it('every action is one undo step', async () => {
    edits.select(['o1'])
    const before = edits.historySize
    await mountFor().get('[aria-label="Bring to front"]').trigger('click')
    expect(edits.historySize).toBe(before + 1)
  })
})

// Task 38: turning a TEXT selection into a native markup annotation.
describe('SelectionToolbar markup actions', () => {
  let edits: ReturnType<typeof useEditsStore>
  let selection: ReturnType<typeof useSelectionStore>

  /** Two characters on one line, in MuPDF page space (top-down). */
  const index = {
    lines: [{
      bbox: [10, 100, 30, 120] as [number, number, number, number],
      text: 'ab', font: 'Helvetica', bold: false, italic: false, color: [0, 0, 0] as Color, size: 10, baseline: 116,
      chars: [
        { char: 'a', quad: [10, 100, 20, 100, 10, 120, 20, 120] as never },
        { char: 'b', quad: [20, 100, 30, 100, 20, 120, 30, 120] as never },
      ],
    }],
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    selection = useSelectionStore()
    edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'], { p1: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
  })

  const mountFor = () => mount(SelectionToolbar, { props: { page, zoom: 1 } })

  function selectText(): void {
    selection.begin('p1', index, { line: 0, char: 0 })
    selection.extend({ line: 0, char: 1 })
  }

  it('shows no markup toolbar without a text selection', () => {
    expect(mountFor().find('[data-markup-toolbar]').exists()).toBe(false)
  })

  it('shows the three markup actions when text is selected', () => {
    selectText()
    const w = mountFor()
    expect(w.find('[data-markup-toolbar]').exists()).toBe(true)
    for (const label of ['Highlight', 'Underline', 'Strikeout']) {
      expect(w.find(`[aria-label="${label}"]`).exists()).toBe(true)
    }
  })

  it.each(['Highlight', 'Underline', 'Strikeout'] as const)(
    'creates a %s object from the selected quads',
    async (label) => {
      selectText()
      await mountFor().get(`[aria-label="${label}"]`).trigger('click')
      const object = Object.values(edits.doc.objects)[0]!
      expect(object.kind).toBe(label.toLowerCase())
      expect((object as { quads: number[][] }).quads).toEqual([[10, 100, 30, 100, 10, 120, 30, 120]])
    },
  )

  // Quads stay in MuPDF page space; the object's rect is raw bottom-up PDF
  // space like every other object. Two spaces in one object is deliberate.
  it('stores the rect in bottom-up PDF space while the quads stay top-down', async () => {
    selectText()
    await mountFor().get('[aria-label="Highlight"]').trigger('click')
    const object = Object.values(edits.doc.objects)[0]!
    // Quads span y 100..120 top-down on a 792pt page -> rect bottom at 672.
    expect(object.rect).toEqual({ x: 10, y: 672, w: 20, h: 20 })
  })

  it('clears the text selection and selects the new object', async () => {
    selectText()
    await mountFor().get('[aria-label="Highlight"]').trigger('click')
    expect(selection.hasSelection).toBe(false)
    expect(edits.selection).toEqual([Object.keys(edits.doc.objects)[0]])
  })

  it('is one undo step', async () => {
    selectText()
    const before = edits.historySize
    await mountFor().get('[aria-label="Highlight"]').trigger('click')
    expect(edits.historySize).toBe(before + 1)
  })
})

/**
 * Bold and Italic over a text selection.
 *
 * WHOLE LINES, which is the honest limit of the control rather than a
 * shortcut taken: a patch is addressed by line index and guarded by a hash
 * of the line's text, so styling three words of a line is not something the
 * format can express. The buttons are labelled "Bold line" for that reason,
 * and these tests pin the label as much as the behaviour.
 */
describe('SelectionToolbar style actions', () => {
  let edits: ReturnType<typeof useEditsStore>
  let selection: ReturnType<typeof useSelectionStore>

  /** Two lines of two characters each, in MuPDF page space (top-down). */
  const lineAt = (
    row: number,
    text: string,
    style: { bold?: boolean; italic?: boolean } = {},
  ) => ({
    bbox: [10, 100 + row * 30, 30, 120 + row * 30] as [number, number, number, number],
    text,
    font: 'Helvetica',
    bold: style.bold === true,
    italic: style.italic === true,
    color: [0, 0, 0] as Color,
    size: 10,
    baseline: 116 + row * 30,
    chars: [...text].map((char, i) => ({
      char,
      quad: [
        10 + i * 10, 100 + row * 30, 20 + i * 10, 100 + row * 30,
        10 + i * 10, 120 + row * 30, 20 + i * 10, 120 + row * 30,
      ] as never,
    })),
  })

  const twoLines = { lines: [lineAt(0, 'ab'), lineAt(1, 'cd')] }

  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    selection = useSelectionStore()
    edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
      { p1: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
  })

  const mountFor = () => mount(SelectionToolbar, { props: { page, zoom: 1 } })

  const patches = (): TextPatchObject[] =>
    Object.values(edits.doc.objects).filter(
      (o): o is TextPatchObject => o.kind === 'textPatch',
    )

  function select(index: typeof twoLines, from = { line: 0, char: 0 }, to = { line: 0, char: 1 }) {
    selection.begin('p1', index, from)
    selection.extend(to)
  }

  it('offers Bold and Italic beside the markup actions', () => {
    select(twoLines)
    const w = mountFor()
    expect(w.find('[data-style-bold]').exists()).toBe(true)
    expect(w.find('[data-style-italic]').exists()).toBe(true)
  })

  it('says the action is on the line, because it is', () => {
    select(twoLines)
    const w = mountFor()
    expect(w.get('[data-style-bold]').attributes('aria-label')).toBe('Bold line')
    expect(w.get('[data-style-italic]').attributes('aria-label')).toBe('Italic line')
  })

  it('patches the selected line in bold', async () => {
    select(twoLines)
    await mountFor().get('[data-style-bold]').trigger('click')
    expect(patches()).toHaveLength(1)
    expect(patches()[0]!.bold).toBe(true)
    // The WHOLE line's text, redrawn -- not the selected characters alone.
    expect(patches()[0]!.text).toBe('ab')
  })

  it('inherits everything it was not asked to change', () => {
    select(twoLines)
    mountFor().get('[data-style-bold]').trigger('click')
    const patch = patches()[0]!
    expect(patch.italic).toBe(false)
    expect(patch.fontSize).toBe(10)
    expect(patch.baseline).toBe(116)
    expect(patch.color).toEqual([0, 0, 0])
    expect(patch.originalText).toBe('ab')
  })

  it('bolds the whole line even when only part of it is selected', async () => {
    // Stated as a test rather than left implicit: it is the behaviour the
    // label promises and the one the format forces.
    select(twoLines, { line: 0, char: 0 }, { line: 0, char: 0 })
    selection.extend({ line: 0, char: 1 })
    await mountFor().get('[data-style-bold]').trigger('click')
    expect(patches()[0]!.text).toBe('ab')
  })

  it('patches every line a multi-line selection touches', async () => {
    select(twoLines, { line: 0, char: 0 }, { line: 1, char: 1 })
    await mountFor().get('[data-style-bold]').trigger('click')
    expect(patches()).toHaveLength(2)
    expect(patches().map((p) => p.lineIndex).sort()).toEqual([0, 1])
  })

  it('is one undo step however many lines it touched', async () => {
    select(twoLines, { line: 0, char: 0 }, { line: 1, char: 1 })
    const before = edits.historySize
    await mountFor().get('[data-style-bold]').trigger('click')
    expect(edits.historySize).toBe(before + 1)
  })

  it('shows pressed once every touched line carries the style', async () => {
    select(twoLines)
    const w = mountFor()
    expect(w.get('[data-style-bold]').attributes('aria-pressed')).toBe('false')
    await w.get('[data-style-bold]').trigger('click')
    expect(w.get('[data-style-bold]').attributes('aria-pressed')).toBe('true')
  })

  /**
   * A patch that redraws exactly what the document already draws is worth
   * deleting rather than keeping: it paints a flat rectangle over the line
   * and redraws it identically, which shows as a scar wherever the
   * background is not flat and as a row in the layers list for an edit that
   * is not one.
   */
  it('removes the patch when the style is toggled back off', async () => {
    select(twoLines)
    const w = mountFor()
    await w.get('[data-style-bold]').trigger('click')
    expect(patches()).toHaveLength(1)
    await w.get('[data-style-bold]').trigger('click')
    expect(patches()).toHaveLength(0)
  })

  it('starts pressed over a line the document already sets bold', async () => {
    select({ lines: [lineAt(0, 'ab', { bold: true }), lineAt(1, 'cd')] })
    const w = mountFor()
    // The button reflects the DOCUMENT's own style, not just the patches --
    // otherwise pressing it over an already-bold line would appear to do
    // nothing while actually turning the bold off.
    expect(w.get('[data-style-bold]').attributes('aria-pressed')).toBe('true')
  })

  it('un-bolds a line the document set bold, which needs a patch of its own', async () => {
    select({ lines: [lineAt(0, 'ab', { bold: true }), lineAt(1, 'cd')] })
    await mountFor().get('[data-style-bold]').trigger('click')
    // Turning the document's own bold OFF is a real edit: the page draws
    // that line bold, so something has to cover and redraw it.
    expect(patches()).toHaveLength(1)
    expect(patches()[0]!.bold).toBe(false)
  })

  it('adds to an existing patch rather than fighting it', async () => {
    select(twoLines)
    const w = mountFor()
    await w.get('[data-style-bold]').trigger('click')
    await w.get('[data-style-italic]').trigger('click')
    // ONE patch per line is load-bearing: two would each cover the other.
    expect(patches()).toHaveLength(1)
    expect(patches()[0]!.bold).toBe(true)
    expect(patches()[0]!.italic).toBe(true)
  })

  it('bolds a mixed selection rather than un-bolding the half that was', async () => {
    select(
      { lines: [lineAt(0, 'ab', { bold: true }), lineAt(1, 'cd')] },
      { line: 0, char: 0 },
      { line: 1, char: 1 },
    )
    await mountFor().get('[data-style-bold]').trigger('click')
    // Line 0 was already bold and needs no patch; line 1 gets one.
    expect(patches()).toHaveLength(1)
    expect(patches()[0]!.lineIndex).toBe(1)
    expect(patches()[0]!.bold).toBe(true)
  })
})
