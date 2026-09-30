import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import type { EditObject, TextObject, TextPatchObject } from '@margin/pdf-core'
import TextObjectView from '@/features/overlay/objects/TextObject.vue'
import TextPatchObjectView from '@/features/overlay/objects/TextPatchObject.vue'
import TextEditor from '@/features/overlay/TextEditor.vue'
import Inspector from '@/features/tools/Inspector.vue'
import { fieldsFor } from '@/features/tools/inspectorFields'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import type { PageState } from '@/stores/document'
import { seedDocument } from '../helpers/seedDocument'

/**
 * Letter and line spacing, on screen.
 *
 * The invariant is the one every renderer in this directory holds: the
 * PREVIEW AGREES WITH THE EXPORT. The writer adds the spacing between each
 * pair of characters and stacks lines at the stored multiple of the size;
 * these components must do the same, or the text moves on download.
 *
 * The test setup's canvas stub measures every character the same, so the
 * alignment cases compare a spaced line against the same line unspaced:
 * whatever the glyphs measure, the difference is the gaps.
 */
const text = (over: Partial<TextObject> = {}): TextObject => ({
  id: 't1', pageId: 'p1', kind: 'text', text: 'Spaced out',
  rect: { x: 60, y: 500, w: 400, h: 60 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  fontFamily: 'Inter', fontSize: 18, color: [0, 0, 0], align: 'left',
  ...over,
})

const patch = (over: Partial<TextPatchObject> = {}): TextPatchObject => ({
  id: 'x1', pageId: 'p1', kind: 'textPatch',
  lineIndex: 0, originalHash: 'abcd1234', originalText: 'Original',
  text: 'Replacement',
  fontFamily: 'Inter', fontSize: 12, baseline: 114, color: [0, 0, 0],
  background: [1, 1, 1], backgroundConfidence: 1, fit: 'overflow',
  rect: { x: 40, y: 100, w: 120, h: 18 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  ...over,
})

describe('TextObject: letter spacing', () => {
  const textsOf = (o: TextObject) => mount(TextObjectView, { props: { object: o } }).findAll('text')

  it('spaces the glyphs by the stored amount', () => {
    expect(textsOf(text({ letterSpacing: 4 }))[0]!.attributes('letter-spacing')).toBe('4')
  })

  it('sets no spacing when none is stored, which is what every stored object means', () => {
    expect(textsOf(text())[0]!.attributes('letter-spacing')).toBeUndefined()
  })

  const startOf = (o: TextObject) => Number(textsOf(o)[0]!.attributes('x'))

  it('centres a spaced line counting the gaps, as the writer does', () => {
    // 10 characters, 9 gaps of 4: the line is 36 wider, so it starts 18
    // further in.
    expect(startOf(text({ letterSpacing: 4, align: 'center' })))
      .toBeCloseTo(startOf(text({ align: 'center' })) - 18, 5)
  })

  it('ends a spaced right-aligned line at the box edge', () => {
    expect(startOf(text({ letterSpacing: 4, align: 'right' })))
      .toBeCloseTo(startOf(text({ align: 'right' })) - 36, 5)
  })
})

describe('TextObject: line spacing', () => {
  const baselines = (o: TextObject) =>
    mount(TextObjectView, { props: { object: o } }).findAll('text').map((t) => -Number(t.attributes('y')))

  it('stacks lines at the stored multiple of the size', () => {
    const [first, second] = baselines(text({ text: 'first\nsecond', lineHeight: 2 }))
    expect(first! - second!).toBeCloseTo(36, 5)
  })

  it('keeps the default pitch when none is stored', () => {
    const [first, second] = baselines(text({ text: 'first\nsecond' }))
    expect(first! - second!).toBeCloseTo(18 * 1.2, 5)
  })

  it('leaves the first line where it was, whatever the pitch', () => {
    expect(baselines(text({ text: 'a\nb', lineHeight: 2 }))[0])
      .toBe(baselines(text({ text: 'a\nb' }))[0])
  })
})

describe('TextPatchObject: letter spacing', () => {
  const textOf = (o: TextPatchObject) =>
    mount(TextPatchObjectView, { props: { object: o } }).get('text')

  it('spaces the glyphs by the stored amount', () => {
    expect(textOf(patch({ letterSpacing: 3 })).attributes('letter-spacing')).toBe('3')
  })

  it('sets no spacing when none is stored', () => {
    expect(textOf(patch()).attributes('letter-spacing')).toBeUndefined()
  })

  it('counts the gaps when truncating to the line, as the writer does', () => {
    // 11 characters at 12pt of spacing: 10 gaps are 120, which is the
    // line's whole width, so truncate has to cut until the gaps fit.
    const drawn = textOf(patch({ letterSpacing: 12, fit: 'truncate' })).text()
    expect(drawn.length).toBeLessThan('Replacement'.length)
    expect('Replacement'.startsWith(drawn)).toBe(true)
  })
})

describe('TextEditor: spacing', () => {
  const page: PageState = {
    id: 'p1', sourceId: 'src-0', sourceIndex: 0, geometry: { cropBox: [0, 0, 612, 792], rotate: 0 },
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    const edits = useEditsStore()
    edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
      { p1: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
    edits.applyOp({
      type: 'addObject', object: text({ letterSpacing: 4, lineHeight: 2 }) as EditObject,
    }, 'add')
  })

  it('types with the same spacing the glyphs will have, scaled with the zoom', async () => {
    useToolsStore().startEditing('t1')
    const w = mount(TextEditor, { props: { page, zoom: 2 }, attachTo: document.body })
    await w.vm.$nextTick()
    const style = (w.get('[data-text-editor]').element as HTMLElement).style
    const scale = Number(/scale\(([\d.]+)\)/.exec(style.transform)?.[1] ?? 1)
    // Under the same zoom-compensating transform the type size sits under.
    expect(Number.parseFloat(style.letterSpacing) * scale).toBeCloseTo(8, 6)
    expect(style.lineHeight).toBe('2')
    w.unmount()
  })
})

describe('Inspector: spacing fields', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    seedDocument([{ id: 'p1', sourceIndex: 0 }])
  })

  const keys = (o: EditObject) => fieldsFor(o).map((f) => f.key)

  it('offers letter and line spacing on custom text', () => {
    expect(keys(text())).toEqual(expect.arrayContaining(['letterSpacing', 'lineHeight']))
  })

  it('offers letter spacing, and not line spacing, on an edited line of the document', () => {
    // A patch replaces ONE line: there is nothing for a line height to space.
    expect(keys(patch())).toContain('letterSpacing')
    expect(keys(patch())).not.toContain('lineHeight')
  })

  it('writes the spacing onto the object, undoably', async () => {
    const edits = useEditsStore()
    edits.applyOp({ type: 'addObject', object: text() as EditObject }, 'add')
    edits.select(['t1'])
    const w = mount(Inspector)
    await w.get('[data-field="letterSpacing"]').get('input').setValue('2.5')
    await w.get('[data-field="letterSpacing"]').get('input').trigger('change')
    expect((edits.doc.objects.t1 as TextObject).letterSpacing).toBe(2.5)
    edits.undo()
    expect((edits.doc.objects.t1 as TextObject).letterSpacing).toBeUndefined()
  })
})
