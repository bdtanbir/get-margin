import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import Inspector from '@/features/tools/Inspector.vue'
import { useEditsStore } from '@/stores/edits'
import { useDocumentStore } from '@/stores/document'
import { seedDocument } from '../helpers/seedDocument'
import type { EditObject, FieldObject } from '@margin/pdf-core'

// The layers list, which the sidebar shows when nothing is selected, reads
// the viewport store -- and instantiating that reaches for the worker.
vi.mock('../../src/workers/pdfClient.js', () => ({
  getPdfClient: () => ({
    open: vi.fn(), authenticate: vi.fn(), render: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined), terminate: vi.fn(),
  }),
}))

const rect: EditObject = {
  id: 'o1', pageId: 'p1', kind: 'rect',
  rect: { x: 10, y: 20, w: 100, h: 50 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  stroke: [0, 0, 0], strokeWidth: 2, fill: null,
}

describe('Inspector', () => {
  let edits: ReturnType<typeof useEditsStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    // seedDocument rather than edits.reset alone: the layers list resolves
    // each object's page through the document store, which needs the
    // source's geometry as well as the edit store's page entries.
    seedDocument([{ id: 'p1', sourceIndex: 0 }])
    edits.applyOp({ type: 'addObject', object: rect }, 'add')
  })

  /**
   * The sidebar has two states and nothing else: the layers list, and one
   * object's properties. "Select an object to edit its properties" used to
   * be the whole of the first state, which told the user what to do without
   * giving them anything to do it with.
   */
  it('shows the layers list when nothing is selected', () => {
    const w = mount(Inspector)
    expect(w.find('[aria-label="Layers"]').exists()).toBe(true)
    expect(w.find('[data-layer-row="o1"]').exists()).toBe(true)
  })

  it('shows the properties instead of the list once something is selected', () => {
    edits.select(['o1'])
    const w = mount(Inspector)
    expect(w.find('[aria-label="Layers"]').exists()).toBe(false)
    expect(w.find('[data-field="strokeWidth"]').exists()).toBe(true)
  })

  // The panel's accessible name has to follow its state: a screen reader
  // announcing "Properties" over a list of layers describes the surface the
  // sidebar used to be, not the one it is showing.
  it('names the sidebar after what it is showing', () => {
    expect(mount(Inspector).get('aside').attributes('aria-label')).toBe('Layers')
    edits.select(['o1'])
    expect(mount(Inspector).get('aside').attributes('aria-label')).toBe('Properties')
  })

  /**
   * The mobile sheet renders this same component, and it only exists WHILE
   * something is selected -- there is no list behind it to go back to, so
   * the button would dismiss the sheet while promising a list the phone
   * never shows.
   */
  it('hides the back button where there is no list behind it', () => {
    edits.select(['o1'])
    const w = mount(Inspector, { props: { back: false } })
    expect(w.find('[data-layers-back]').exists()).toBe(false)
    expect(w.find('[data-field="strokeWidth"]').exists()).toBe(true)
  })

  it('goes back to the list from the properties', async () => {
    edits.select(['o1'])
    const w = mount(Inspector)
    await w.get('[data-layers-back]').trigger('click')
    expect(edits.selection).toEqual([])
    expect(w.find('[aria-label="Layers"]').exists()).toBe(true)
  })

  it('shows the fields for the selected kind', () => {
    edits.select(['o1'])
    const w = mount(Inspector)
    expect(w.find('[data-field="strokeWidth"]').exists()).toBe(true)
    expect(w.find('[data-field="opacity"]').exists()).toBe(true)
    expect(w.find('[data-field="fontSize"]').exists()).toBe(false)
  })

  /**
   * Opacity is shown as a percentage and stored as the 0..1 the PDF format
   * uses (/CA, and every writer and golden test below it). "0.15" in a box
   * is a number people have to translate; 15 is one they read.
   */
  describe('opacity as a percentage', () => {
    it('shows a stored 0..1 opacity as a percentage', () => {
      edits.applyOp({ type: 'updateObject', id: 'o1', patch: { opacity: 0.15 } }, 'set')
      edits.select(['o1'])
      const input = mount(Inspector).get('[data-field="opacity"] input')
        .element as HTMLInputElement
      expect(input.value).toBe('15')
    })

    it('stores a percentage back as 0..1', async () => {
      edits.select(['o1'])
      const w = mount(Inspector)
      await w.get('[data-field="opacity"] input').setValue('40')
      expect(edits.doc.objects.o1?.opacity).toBe(0.4)
    })

    it('offers the whole percentage range', () => {
      edits.select(['o1'])
      const input = mount(Inspector).get('[data-field="opacity"] input')
      expect(input.attributes('min')).toBe('0')
      expect(input.attributes('max')).toBe('100')
    })

    // Floating point makes 0.29 * 100 into 28.999999999999996, and a box
    // reading "28.999999999999996" is worse than the decimal it replaced.
    it('shows a clean number for an opacity that does not divide evenly', () => {
      edits.applyOp({ type: 'updateObject', id: 'o1', patch: { opacity: 0.29 } }, 'set')
      edits.select(['o1'])
      const input = mount(Inspector).get('[data-field="opacity"] input')
        .element as HTMLInputElement
      expect(input.value).toBe('29')
    })

    // Rotation shares the number field and must not be scaled by it.
    it('leaves rotation in degrees', async () => {
      edits.select(['o1'])
      const w = mount(Inspector)
      await w.get('[data-field="rotation"] input').setValue('45')
      expect(edits.doc.objects.o1?.rotation).toBe(45)
    })
  })

  it('writes changes through applyOp, so they are undoable', async () => {
    edits.select(['o1'])
    const w = mount(Inspector)
    await w.get('[data-field="opacity"] input').setValue('50')
    expect(edits.doc.objects.o1?.opacity).toBe(0.5)
    edits.undo()
    expect(edits.doc.objects.o1?.opacity).toBe(1)
  })

  // NOT wrapper.setValue(): VTU fires `input` AND `change` on every call, so
  // it cannot express a slider still being held -- the exact state this
  // behaviour exists for. A browser fires `input` per pixel of travel and
  // one `change` on release, which is what these helpers reproduce.
  // `w.get()` returns Omit<DOMWrapper, 'exists'>, not DOMWrapper, so the
  // parameter is typed structurally against what this actually uses.
  type Draggable = { element: Element; trigger: (event: string) => Promise<void> }

  const drag = async (input: Draggable, v: string): Promise<void> => {
    ;(input.element as HTMLInputElement).value = v
    await input.trigger('input')
  }

  it('coalesces a slider drag into one history entry', async () => {
    edits.select(['o1'])
    const w = mount(Inspector)
    const input = w.get('[data-field="opacity"] input')
    const before = edits.historySize
    for (const v of ['90', '80', '70', '60']) await drag(input, v)
    // Still held: nothing committed yet, and the value is already live.
    expect(edits.historySize).toBe(before)
    expect(edits.doc.objects.o1?.opacity).toBe(0.6)
    await input.trigger('change')
    expect(edits.historySize).toBe(before + 1)
  })

  it('disables every field on a locked object', async () => {
    edits.applyOp({ type: 'updateObject', id: 'o1', patch: { locked: true } }, 'lock')
    edits.select(['o1'])
    const w = mount(Inspector)
    for (const i of w.findAll('input')) expect(i.attributes('disabled')).toBeDefined()
  })

  it('writes a colour field back as MuPDF 0..1 channels, not a hex string', async () => {
    edits.select(['o1'])
    const w = mount(Inspector)
    await w.get('[data-field="stroke"] input').setValue('#ff0000')
    expect(edits.doc.objects.o1).toMatchObject({ stroke: [1, 0, 0] })
  })

  it('parses numeric fields as numbers, not the input element strings', async () => {
    edits.select(['o1'])
    const w = mount(Inspector)
    await w.get('[data-field="strokeWidth"] input').setValue('3.5')
    expect(edits.doc.objects.o1).toMatchObject({ strokeWidth: 3.5 })
  })

  // A second, separate drag is a second undo step -- coalescing must reset
  // when the gesture ends, not swallow everything after the first one.
  it('starts a new history entry for a second drag', async () => {
    edits.select(['o1'])
    const w = mount(Inspector)
    const input = w.get('[data-field="opacity"] input')
    const before = edits.historySize
    await drag(input, '90')
    await input.trigger('change')
    await drag(input, '40')
    await input.trigger('change')
    expect(edits.historySize).toBe(before + 2)
  })
})

// A link's URL is validated when the edit is COMMITTED, not per keystroke:
// validating mid-typing rejects every prefix of a valid URL, and normalising
// mid-typing fights the caret.
describe('Inspector URL validation', () => {
  const link: EditObject = {
    id: 'l1', pageId: 'p1', kind: 'link', uri: 'https://example.com/',
    rect: { x: 10, y: 20, w: 100, h: 20 },
    rotation: 0, z: 1, locked: false, opacity: 1,
  }

  let edits: ReturnType<typeof useEditsStore>
  let doc: ReturnType<typeof useDocumentStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    doc = useDocumentStore()
    edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'], { p1: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
    edits.applyOp({ type: 'addObject', object: link }, 'add')
    edits.select(['l1'])
  })

  async function setUrl(value: string) {
    const w = mount(Inspector)
    const input = w.get('[data-field="uri"] input')
    ;(input.element as HTMLInputElement).value = value
    await input.trigger('input')
    await input.trigger('change')
    return w
  }

  it('normalises a bare domain on commit', async () => {
    await setUrl('example.org/x')
    expect(edits.doc.objects.l1).toMatchObject({ uri: 'https://example.org/x' })
  })

  it('does not normalise while the user is still typing', async () => {
    const w = mount(Inspector)
    const input = w.get('[data-field="uri"] input')
    ;(input.element as HTMLInputElement).value = 'exa'
    await input.trigger('input')
    // Still the raw prefix -- normalising here would rewrite the field under
    // the caret on every keystroke.
    expect(edits.doc.objects.l1).toMatchObject({ uri: 'exa' })
  })

  it('rejects a javascript: URL and restores the previous value', async () => {
    await setUrl('javascript:alert(1)')
    expect(edits.doc.objects.l1).toMatchObject({ uri: 'https://example.com/' })
    expect(doc.error).toMatch(/not allowed/i)
  })

  it('leaves no open transaction after a rejected edit', async () => {
    await setUrl('javascript:alert(1)')
    const before = edits.historySize
    edits.applyOp({ type: 'updateObject', id: 'l1', patch: { opacity: 0.5 } }, 'Later')
    expect(edits.historySize).toBe(before + 1)
  })
})

describe('Inspector for form fields', () => {
  const fieldObject = (over: Partial<FieldObject> = {}): FieldObject => ({
    id: 'f1', pageId: 'p1', kind: 'field',
    rect: { x: 10, y: 10, w: 100, h: 20 },
    rotation: 0, z: 1, locked: false, opacity: 1,
    fieldType: 'text', name: 'text_1', group: null, exportValue: null,
    value: '', options: [], required: false, readOnly: false,
    multiline: false, maxLength: null, fontSize: 0,
    ...over,
  })

  function open(over: Partial<FieldObject> = {}) {
    const s = useEditsStore()
    s.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
      { p1: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null } })
    const o = fieldObject(over)
    s.applyOp({ type: 'addObject', object: o }, 'Add')
    s.select([o.id])
    return { store: s, wrapper: mount(Inspector) }
  }

  beforeEach(() => { setActivePinia(createPinia()) })

  it('offers the type and the name for every field', () => {
    const { wrapper } = open()
    expect(wrapper.find('[data-field="fieldType"]').exists()).toBe(true)
    expect(wrapper.find('[data-field="name"]').exists()).toBe(true)
  })

  it('changes the field’s type', async () => {
    const { store, wrapper } = open()
    await wrapper.get('[data-field="fieldType"] select').setValue('checkbox')
    expect((store.doc.objects.f1 as FieldObject).fieldType).toBe('checkbox')
  })

  /**
   * Properties follow the TYPE, not just the kind. Offering "Options" on a
   * checkbox is not a setting so much as a question with no answer.
   */
  it('offers options only for choice types', () => {
    expect(open({ fieldType: 'dropdown' }).wrapper.find('[data-field="options"]').exists()).toBe(true)
    expect(open({ fieldType: 'listbox' }).wrapper.find('[data-field="options"]').exists()).toBe(true)
    expect(open({ fieldType: 'checkbox' }).wrapper.find('[data-field="options"]').exists()).toBe(false)
    expect(open({ fieldType: 'text' }).wrapper.find('[data-field="options"]').exists()).toBe(false)
  })

  it('offers multiline and max length only for text', () => {
    expect(open({ fieldType: 'text' }).wrapper.find('[data-field="multiline"]').exists()).toBe(true)
    expect(open({ fieldType: 'checkbox' }).wrapper.find('[data-field="multiline"]').exists()).toBe(false)
    expect(open({ fieldType: 'checkbox' }).wrapper.find('[data-field="maxLength"]').exists()).toBe(false)
  })

  it('offers an option value only for a radio button', () => {
    expect(open({ fieldType: 'radio', exportValue: 'option_1', group: 'g' })
      .wrapper.find('[data-field="exportValue"]').exists()).toBe(true)
    expect(open({ fieldType: 'text' }).wrapper.find('[data-field="exportValue"]').exists()).toBe(false)
  })

  it('toggles a boolean property, undoably', async () => {
    const { store, wrapper } = open()
    await wrapper.get('[data-field="required"] input').setValue(true)
    expect((store.doc.objects.f1 as FieldObject).required).toBe(true)
    store.undo()
    expect((store.doc.objects.f1 as FieldObject).required).toBe(false)
  })

  it('adds and removes options', async () => {
    const { store, wrapper } = open({ fieldType: 'dropdown', options: ['BD'] })
    await wrapper.get('[data-add-option]').trigger('click')
    expect((store.doc.objects.f1 as FieldObject).options).toHaveLength(2)
    await wrapper.get('[data-remove-option="0"]').trigger('click')
    expect((store.doc.objects.f1 as FieldObject).options).toEqual(['Option 2'])
  })

  it('edits an option in place', async () => {
    const { store, wrapper } = open({ fieldType: 'dropdown', options: ['BD', 'CA'] })
    const inputs = wrapper.findAll('[data-field="options"] input')
    await inputs[1]!.setValue('Canada')
    expect((store.doc.objects.f1 as FieldObject).options).toEqual(['BD', 'Canada'])
  })

  /**
   * A field with no /T cannot hold a value -- the format addresses values
   * by name -- so the edit is rejected here and the export never has to.
   */
  it('refuses an empty name and says why', async () => {
    const { store, wrapper } = open()
    const input = wrapper.get('[data-field="name"] input')
    await input.setValue('   ')
    await input.trigger('change')
    expect((store.doc.objects.f1 as FieldObject).name).toBe('text_1')
    expect(useDocumentStore().error).toMatch(/needs a name/)
  })

  // Two buttons sharing an export value are ONE button, and "Off" is the
  // universal unselected state.
  it('refuses a reserved option value', async () => {
    const { store, wrapper } = open({ fieldType: 'radio', exportValue: 'option_1', group: 'g' })
    const input = wrapper.get('[data-field="exportValue"] input')
    await input.setValue('Off')
    await input.trigger('change')
    expect((store.doc.objects.f1 as FieldObject).exportValue).toBe('option_1')
    expect(useDocumentStore().error).toMatch(/reserved/)
  })

  // The alternative is a user believing this app signs documents.
  it('says a signature field is not a signature', () => {
    expect(open({ fieldType: 'signature' }).wrapper.text()).toContain('does not sign documents')
  })
})

/**
 * Weight, from the panel the user actually reaches for it in.
 *
 * A text object had no weight control at all, and an edited line of the
 * document's own text had no properties panel whatsoever -- so a patch that
 * inherited the wrong weight could not be corrected without deleting it and
 * starting again.
 */
describe('Inspector weight controls', () => {
  const textObject: EditObject = {
    id: 't1', pageId: 'p1', kind: 'text', text: 'Hello',
    rect: { x: 10, y: 20, w: 100, h: 20 },
    rotation: 0, z: 1, locked: false, opacity: 1,
    fontFamily: 'Inter', bold: false, italic: false, fontSize: 14,
    color: [0, 0, 0], align: 'left',
  }

  const patchObject: EditObject = {
    id: 'x1', pageId: 'p1', kind: 'textPatch',
    lineIndex: 0, originalHash: 'abcd1234', originalText: 'Was bold',
    text: 'Now says this',
    fontFamily: 'Inter', bold: true, italic: true, fontSize: 11, baseline: 118,
    color: [0, 0, 0],
    background: [1, 1, 1], backgroundConfidence: 1, fit: 'overflow',
    rect: { x: 10, y: 20, w: 100, h: 20 },
    rotation: 0, z: 1, locked: false, opacity: 1,
  }

  let edits: ReturnType<typeof useEditsStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    seedDocument([{ id: 'p1', sourceIndex: 0 }])
  })

  const boldBox = (w: ReturnType<typeof mount>) =>
    w.get('[data-field="bold"]').get('input')

  const italicBox = (w: ReturnType<typeof mount>) =>
    w.get('[data-field="italic"]').get('input')

  it('offers Bold on a text object', () => {
    edits.applyOp({ type: 'addObject', object: textObject }, 'add')
    edits.select(['t1'])
    expect(boldBox(mount(Inspector)).attributes('type')).toBe('checkbox')
  })

  it('writes the weight onto the object when it is ticked', async () => {
    edits.applyOp({ type: 'addObject', object: textObject }, 'add')
    edits.select(['t1'])
    const w = mount(Inspector)
    await boldBox(w).setValue(true)
    expect((edits.doc.objects.t1 as { bold?: boolean }).bold).toBe(true)
  })

  it('offers Bold on an edited line of the document’s own text', () => {
    edits.applyOp({ type: 'addObject', object: patchObject }, 'add')
    edits.select(['x1'])
    const w = mount(Inspector)
    // Ticked, because the patch inherited the weight of the line it
    // replaced -- which is the whole fix, shown back to the user.
    expect((boldBox(w).element as HTMLInputElement).checked).toBe(true)
  })

  it('lets the inherited weight be corrected after the fact', async () => {
    edits.applyOp({ type: 'addObject', object: patchObject }, 'add')
    edits.select(['x1'])
    const w = mount(Inspector)
    await boldBox(w).setValue(false)
    expect((edits.doc.objects.x1 as { bold?: boolean }).bold).toBe(false)
  })

  /**
   * A patch redraws a line the document laid out, from that line's own left
   * edge. It has no box of its own to align within, so the control would be
   * three choices that all did the same thing.
   */
  it('does not offer alignment on a text patch', () => {
    edits.applyOp({ type: 'addObject', object: patchObject }, 'add')
    edits.select(['x1'])
    expect(mount(Inspector).find('[data-field="align"]').exists()).toBe(false)
  })

  it('offers Italic on a text object, and writes it', async () => {
    edits.applyOp({ type: 'addObject', object: textObject }, 'add')
    edits.select(['t1'])
    const w = mount(Inspector)
    await italicBox(w).setValue(true)
    expect((edits.doc.objects.t1 as { italic?: boolean }).italic).toBe(true)
  })

  it('offers Italic on an edited line, ticked from what the line was', () => {
    edits.applyOp({ type: 'addObject', object: patchObject }, 'add')
    edits.select(['x1'])
    expect((italicBox(mount(Inspector)).element as HTMLInputElement).checked).toBe(true)
  })

  it('keeps bold and italic as separate switches, not one Style picker', async () => {
    // They combine -- bold italic is a fourth face -- so a four-option list
    // would be spelling out the product of two independent switches.
    edits.applyOp({ type: 'addObject', object: patchObject }, 'add')
    edits.select(['x1'])
    const w = mount(Inspector)
    await italicBox(w).setValue(false)
    expect((edits.doc.objects.x1 as { italic?: boolean }).italic).toBe(false)
    expect((edits.doc.objects.x1 as { bold?: boolean }).bold).toBe(true)
  })

  it('offers Size on an edited line, showing the size the line was set in', () => {
    edits.applyOp({ type: 'addObject', object: patchObject }, 'add')
    edits.select(['x1'])
    const box = mount(Inspector).get('[data-field="fontSize"]').get('input')
    expect((box.element as HTMLInputElement).value).toBe('11')
  })

  it('writes a new size onto the patch', async () => {
    edits.applyOp({ type: 'addObject', object: patchObject }, 'add')
    edits.select(['x1'])
    const w = mount(Inspector)
    await w.get('[data-field="fontSize"]').get('input').setValue('18')
    expect((edits.doc.objects.x1 as { fontSize: number }).fontSize).toBe(18)
  })
})
