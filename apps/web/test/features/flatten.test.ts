import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import TopBar from '@/app/TopBar.vue'
import { useEditsStore } from '@/stores/edits'
import { useFieldsStore } from '@/stores/fields'
import type { SourceField, EditObject } from '@margin/pdf-core'

const listFields = vi.fn<(sourceId: string | undefined, page: number) => Promise<SourceField[]>>()

vi.mock('@/workers/pdfClient', () => ({
  getPdfClient: () => ({ listFields, save: vi.fn() }),
  closeSharedDocument: vi.fn(),
}))

const fieldObject = (): EditObject => ({
  id: 'f1', pageId: 'p1', kind: 'field',
  rect: { x: 10, y: 10, w: 100, h: 20 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  fieldType: 'text', name: 'n', group: null, exportValue: null,
  value: '', options: [], required: false, readOnly: false,
  multiline: false, maxLength: null, fontSize: 12,
})

function seed() {
  const s = useEditsStore()
  s.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
    { p1: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null } })
  return s
}

describe('flatten forms option', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listFields.mockReset()
    listFields.mockResolvedValue([])
  })

  // Offering to flatten a document with no form is noise.
  it('is not offered when there is no form', () => {
    seed()
    expect(mount(TopBar).find('[data-flatten-forms]').exists()).toBe(false)
  })

  it('is offered once a source page with fields has been seen', async () => {
    seed()
    listFields.mockResolvedValue([{
      key: 'a', name: 'a', type: 'text', rect: { x: 0, y: 0, w: 10, h: 10 },
      value: '', state: null, exportValue: null, options: [],
      readOnly: false, required: false, multiline: false, maxLength: null,
    }])
    await useFieldsStore().load('src-0', 0)
    expect(mount(TopBar).find('[data-flatten-forms]').exists()).toBe(true)
  })

  it('is offered for a field the user created', () => {
    const s = seed()
    s.applyOp({ type: 'addObject', object: fieldObject() }, 'Add field')
    expect(mount(TopBar).find('[data-flatten-forms]').exists()).toBe(true)
  })

  /**
   * Off by default, and it has to be. Flattening is a one-way door: the
   * fields are gone from the exported file, and a user who wanted a
   * fillable form back has to redo the work.
   */
  it('is off by default', () => {
    const s = seed()
    s.applyOp({ type: 'addObject', object: fieldObject() }, 'Add field')
    const w = mount(TopBar)
    expect((w.get('[data-flatten-forms] input').element as HTMLInputElement).checked).toBe(false)
    expect(s.doc.flattenForms).toBe(false)
  })

  it('records the choice as an undoable edit', async () => {
    const s = seed()
    s.applyOp({ type: 'addObject', object: fieldObject() }, 'Add field')
    const w = mount(TopBar)
    await w.get('[data-flatten-forms] input').setValue(true)
    expect(s.doc.flattenForms).toBe(true)
    s.undo()
    expect(s.doc.flattenForms).toBe(false)
  })

  // "Flatten" is a word from the file format, not from the user's problem.
  it('says what happens rather than naming the operation', () => {
    const s = seed()
    s.applyOp({ type: 'addObject', object: fieldObject() }, 'Add field')
    expect(mount(TopBar).get('[data-flatten-forms]').text()).toBe('Lock form answers')
  })
})
