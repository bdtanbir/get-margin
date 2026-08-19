import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import FieldLayer from '@/features/forms/FieldLayer.vue'
import { useEditsStore } from '@/stores/edits'
import { useFieldsStore } from '@/stores/fields'
import type { PageState } from '@/stores/document'
import type { SourceField } from '@margin/pdf-core'

const listFields = vi.fn<(sourceId: string | undefined, page: number) => Promise<SourceField[]>>()

vi.mock('@/workers/pdfClient', () => ({
  getPdfClient: () => ({ listFields }),
  closeSharedDocument: vi.fn(),
}))

const page: PageState = {
  id: 'p1', sourceId: 'src-0', sourceIndex: 0,
  geometry: { cropBox: [0, 0, 612, 792], rotate: 0 },
}

function sourceField(over: Partial<SourceField> = {}): SourceField {
  return {
    key: 'fullname', name: 'fullname', type: 'text',
    rect: { x: 100, y: 368, w: 200, h: 24 },
    value: '', state: null, exportValue: null, options: [],
    readOnly: false, required: false, multiline: false, maxLength: null,
    ...over,
  }
}

async function mountLayer(fields: SourceField[], zoom = 1) {
  listFields.mockResolvedValue(fields)
  const w = mount(FieldLayer, { props: { page, zoom } })
  await flushPromises()
  return w
}

describe('FieldLayer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listFields.mockReset()
    useEditsStore().reset(
      { 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
      { p1: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null } },
    )
  })

  it('renders nothing for a page with no fields', async () => {
    const w = await mountLayer([])
    expect(w.find('[data-field-layer]').exists()).toBe(false)
  })

  it('renders one control per field', async () => {
    const w = await mountLayer([
      sourceField({ key: 'a', name: 'a' }),
      sourceField({ key: 'b', name: 'b' }),
    ])
    expect(w.findAll('[data-field]')).toHaveLength(2)
  })

  it('renders the right control for each type', async () => {
    const w = await mountLayer([
      sourceField({ key: 'a', type: 'text' }),
      sourceField({ key: 'b', type: 'text', multiline: true }),
      sourceField({ key: 'c', type: 'checkbox' }),
      sourceField({ key: 'd', type: 'dropdown', options: ['x', 'y'] }),
      sourceField({ key: 'e', type: 'signature' }),
    ])
    expect(w.get('[data-field="a"]').element.tagName).toBe('INPUT')
    expect(w.get('[data-field="a"]').attributes('type')).toBe('text')
    expect(w.get('[data-field="b"]').element.tagName).toBe('TEXTAREA')
    expect(w.get('[data-field="c"]').attributes('type')).toBe('checkbox')
    expect(w.get('[data-field="d"]').element.tagName).toBe('SELECT')
    // A signature field is a place for a signature, not something to type
    // into: offering an input would imply it means something.
    expect(w.get('[data-field="e"]').element.tagName).toBe('DIV')
  })

  it('offers every option of a choice field, plus an empty one', async () => {
    const w = await mountLayer([sourceField({ type: 'dropdown', options: ['BD', 'CA'] })])
    // The empty option exists so a field that has never been answered can
    // be returned to that state.
    expect(w.findAll('option').map((o) => o.attributes('value'))).toEqual(['', 'BD', 'CA'])
  })

  /**
   * The rect is already in the renderer's space (Convention A), so the only
   * conversion is points to pixels. Running it through the page transform
   * again would move every field.
   */
  it('positions a field by scaling points to pixels, with no page transform', async () => {
    const w = await mountLayer([sourceField({ rect: { x: 100, y: 368, w: 200, h: 24 } })], 2)
    const style = w.get('[data-field]').attributes('style') ?? ''
    expect(style).toContain('left: 200px')
    expect(style).toContain('top: 736px')
    expect(style).toContain('width: 400px')
    expect(style).toContain('height: 48px')
  })

  it('shows the value the document shipped with', async () => {
    const w = await mountLayer([sourceField({ value: 'Ada' })])
    expect((w.get('[data-field]').element as HTMLInputElement).value).toBe('Ada')
  })

  it('writes typing to the edit store', async () => {
    const w = await mountLayer([sourceField({ key: 'fullname' })])
    await w.get('[data-field]').setValue('Grace')
    expect(useEditsStore().doc.fieldValues.fullname).toBe('Grace')
  })

  it('records a burst of typing as one undo entry', async () => {
    const w = await mountLayer([sourceField({ key: 'fullname' })])
    const edits = useEditsStore()
    edits.clearHistory()
    for (const v of ['G', 'Gr', 'Gra', 'Grac', 'Grace']) {
      await w.get('[data-field]').setValue(v)
    }
    expect(edits.historySize).toBe(1)
  })

  /**
   * A user who clears a pre-filled field must not see the text reappear.
   * `undefined` (never touched) and `''` (deliberately emptied) are
   * different answers, and falling back on the second is a real bug.
   */
  it('shows an emptied field as empty, not as the document’s value', async () => {
    const w = await mountLayer([sourceField({ key: 'fullname', value: 'Ada' })])
    await w.get('[data-field]').setValue('')
    expect((w.get('[data-field]').element as HTMLInputElement).value).toBe('')
  })

  // Greyed says "this exists and you may not change it". Omitting it says
  // "there is nothing here", which is a different and false claim.
  it('disables a read-only field rather than hiding it', async () => {
    const w = await mountLayer([sourceField({ readOnly: true })])
    expect(w.get('[data-field]').attributes('disabled')).toBeDefined()
  })

  it('gives every control an accessible name', async () => {
    const w = await mountLayer([
      sourceField({ key: 'a', name: 'Full name' }),
      sourceField({ key: 'b', name: 'Agree', type: 'checkbox' }),
    ])
    expect(w.get('[data-field="a"]').attributes('aria-label')).toBe('Full name')
    expect(w.get('[data-field="b"]').attributes('aria-label')).toBe('Agree')
  })

  it('asks the worker once per page, however often it re-renders', async () => {
    const w = await mountLayer([sourceField()])
    await w.setProps({ zoom: 2 })
    await w.setProps({ zoom: 3 })
    await flushPromises()
    expect(listFields).toHaveBeenCalledTimes(1)
  })

  it('survives a worker that cannot read the page', async () => {
    listFields.mockRejectedValue(new Error('nope'))
    const w = mount(FieldLayer, { props: { page, zoom: 1 } })
    await flushPromises()
    expect(w.find('[data-field-layer]').exists()).toBe(false)
    // Cached as empty, so a page that fails once is not retried forever.
    await useFieldsStore().load('src-0', 0)
    expect(listFields).toHaveBeenCalledTimes(1)
  })
})

/**
 * THE ONE THAT FAILS QUIETLY. A radio kid's value is the GROUP's, so every
 * button in a group carries the selected option -- render "checked" from it
 * and all of them appear chosen (findings 12 3).
 */
describe('FieldLayer radio groups', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listFields.mockReset()
    useEditsStore().reset(
      { 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
      { p1: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null } },
    )
  })

  const group = (selected: string) => ['alpha', 'beta', 'gamma'].map((state) => sourceField({
    key: 'choice', name: 'choice', type: 'radio', exportValue: state,
    // Every kid reports the GROUP's value -- this is what the format does.
    value: selected,
    state: state === selected ? state : 'Off',
  }))

  it('checks exactly one button, not all of them', async () => {
    const w = await mountLayer(group('beta'))
    const checked = w.findAll('input[type="radio"]')
      .filter((r) => (r.element as HTMLInputElement).checked)
    expect(checked).toHaveLength(1)
    expect(checked[0]!.attributes('data-export-value')).toBe('beta')
  })

  it('checks none when none is selected', async () => {
    const w = await mountLayer(group(''))
    expect(w.findAll('input[type="radio"]')
      .filter((r) => (r.element as HTMLInputElement).checked)).toHaveLength(0)
  })

  // The stored value NAMES the selected button. Emitting `true` would make
  // every button in the group claim the selection on the next render.
  it('stores the button’s export value, not a boolean', async () => {
    const w = await mountLayer(group(''))
    await w.findAll('input[type="radio"]')[2]!.trigger('change')
    expect(useEditsStore().doc.fieldValues.choice).toBe('gamma')
  })

  it('moves the selection when another button is chosen', async () => {
    const w = await mountLayer(group('alpha'))
    await w.findAll('input[type="radio"]')[1]!.trigger('change')
    await flushPromises()
    const checked = w.findAll('input[type="radio"]')
      .filter((r) => (r.element as HTMLInputElement).checked)
    expect(checked).toHaveLength(1)
    expect(checked[0]!.attributes('data-export-value')).toBe('beta')
  })
})
