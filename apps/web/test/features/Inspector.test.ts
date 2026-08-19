import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import Inspector from '@/features/tools/Inspector.vue'
import { useEditsStore } from '@/stores/edits'
import { useDocumentStore } from '@/stores/document'
import type { EditObject, FieldObject } from '@margin/pdf-core'

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
    edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'], { p1: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
    edits.applyOp({ type: 'addObject', object: rect }, 'add')
  })

  it('prompts to select something when nothing is selected', () => {
    expect(mount(Inspector).text()).toContain('Select an object')
  })

  it('shows the fields for the selected kind', () => {
    edits.select(['o1'])
    const w = mount(Inspector)
    expect(w.find('[data-field="strokeWidth"]').exists()).toBe(true)
    expect(w.find('[data-field="opacity"]').exists()).toBe(true)
    expect(w.find('[data-field="fontSize"]').exists()).toBe(false)
  })

  it('writes changes through applyOp, so they are undoable', async () => {
    edits.select(['o1'])
    const w = mount(Inspector)
    await w.get('[data-field="opacity"] input').setValue('0.5')
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
    for (const v of ['0.9', '0.8', '0.7', '0.6']) await drag(input, v)
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
    await drag(input, '0.9')
    await input.trigger('change')
    await drag(input, '0.4')
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
