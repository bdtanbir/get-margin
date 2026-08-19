import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import TabOrderList from '@/features/tools/TabOrderList.vue'
import { useEditsStore } from '@/stores/edits'
import { useFieldsStore } from '@/stores/fields'
import type { FieldObject, SourceField } from '@margin/pdf-core'

const listFields = vi.fn<(sourceId: string | undefined, page: number) => Promise<SourceField[]>>()
vi.mock('@/workers/pdfClient', () => ({
  getPdfClient: () => ({ listFields }),
  closeSharedDocument: vi.fn(),
}))

const fieldObject = (name: string, z: number): FieldObject => ({
  id: `f_${name}`, pageId: 'p1', kind: 'field',
  rect: { x: 10, y: 10, w: 100, h: 20 },
  rotation: 0, z, locked: false, opacity: 1,
  fieldType: 'text', name, group: null, exportValue: null,
  value: '', options: [], required: false, readOnly: false,
  multiline: false, maxLength: null, fontSize: 0,
})

function seed(names: string[]) {
  const s = useEditsStore()
  s.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
    { p1: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null } })
  names.forEach((n, i) => s.applyOp({ type: 'addObject', object: fieldObject(n, i) }, 'Add'))
  return s
}

const shown = (w: ReturnType<typeof mount>) =>
  w.findAll('[data-tab-field]').map((li) => li.attributes('data-tab-field'))

describe('TabOrderList', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listFields.mockReset()
    listFields.mockResolvedValue([])
  })

  // One field has no order to speak of.
  it('says nothing when there is nothing to order', () => {
    seed(['only'])
    expect(mount(TabOrderList, { props: { pageId: 'p1' } }).find('[data-tab-order]').exists())
      .toBe(false)
  })

  it('lists the page’s fields in document order by default', () => {
    seed(['a', 'b', 'c'])
    expect(shown(mount(TabOrderList, { props: { pageId: 'p1' } }))).toEqual(['a', 'b', 'c'])
  })

  it('moves a field later, and records it undoably', async () => {
    const s = seed(['a', 'b', 'c'])
    const w = mount(TabOrderList, { props: { pageId: 'p1' } })
    await w.get('[data-move-down="a"]').trigger('click')
    expect(shown(w)).toEqual(['b', 'a', 'c'])
    expect(s.doc.pages.p1!.tabOrder).toEqual(['b', 'a', 'c'])
    s.undo()
    expect(s.doc.pages.p1!.tabOrder ?? []).toEqual([])
  })

  it('moves a field earlier', async () => {
    seed(['a', 'b', 'c'])
    const w = mount(TabOrderList, { props: { pageId: 'p1' } })
    await w.get('[data-move-up="c"]').trigger('click')
    expect(shown(w)).toEqual(['a', 'c', 'b'])
  })

  it('cannot move the first field earlier or the last later', () => {
    seed(['a', 'b'])
    const w = mount(TabOrderList, { props: { pageId: 'p1' } })
    expect(w.get('[data-move-up="a"]').attributes('disabled')).toBeDefined()
    expect(w.get('[data-move-down="b"]').attributes('disabled')).toBeDefined()
  })

  // Tab order is a keyboard feature; offering it only to people who can
  // drag a target would be a poor joke.
  it('names every control for a screen reader', () => {
    seed(['a', 'b'])
    const w = mount(TabOrderList, { props: { pageId: 'p1' } })
    expect(w.get('[data-move-down="a"]').attributes('aria-label')).toBe('Move a later')
    expect(w.get('[data-move-up="b"]').attributes('aria-label')).toBe('Move b earlier')
  })

  it('includes fields the source document already had', async () => {
    listFields.mockResolvedValue([{
      key: 'theirs', name: 'theirs', type: 'text', rect: { x: 0, y: 0, w: 10, h: 10 },
      value: '', state: null, exportValue: null, options: [],
      readOnly: false, required: false, multiline: false, maxLength: null,
    }])
    seed(['ours'])
    await useFieldsStore().load('src-0', 0)
    expect(shown(mount(TabOrderList, { props: { pageId: 'p1' } }))).toEqual(['theirs', 'ours'])
  })

  // A radio group is ONE field, however many buttons it has.
  it('lists a radio group once', () => {
    const s = useEditsStore()
    s.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
      { p1: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null } })
    s.applyOp({ type: 'addObject', object: fieldObject('text_1', 0) }, 'Add')
    ;['yes', 'no'].forEach((v, i) => s.applyOp({
      type: 'addObject',
      object: { ...fieldObject('choice', i + 1), id: `r${i}`, fieldType: 'radio', group: 'choice', exportValue: v },
    }, 'Add'))
    expect(shown(mount(TabOrderList, { props: { pageId: 'p1' } }))).toEqual(['text_1', 'choice'])
  })

  // The list has to show what the export will do, so it applies the same
  // rule the writer does: stored order first, then anything unmentioned.
  it('puts fields the stored order does not mention last', () => {
    const s = seed(['a', 'b', 'c'])
    s.applyOp({ type: 'setTabOrder', pageId: 'p1', order: ['c'] }, 'Reorder fields')
    expect(shown(mount(TabOrderList, { props: { pageId: 'p1' } }))).toEqual(['c', 'a', 'b'])
  })

  it('ignores a stored name whose field is gone', () => {
    const s = seed(['a', 'b'])
    s.applyOp({ type: 'setTabOrder', pageId: 'p1', order: ['deleted', 'b', 'a'] }, 'Reorder fields')
    expect(shown(mount(TabOrderList, { props: { pageId: 'p1' } }))).toEqual(['b', 'a'])
  })
})
