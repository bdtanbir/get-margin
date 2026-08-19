import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import PageOverlay from '@/features/overlay/PageOverlay.vue'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { newFieldNames, uniqueFieldName, currentRadioGroup, uniqueExportValue } from '@/features/forms/fieldNaming'
import type { PageState } from '@/stores/document'
import type { FieldObject, EditObject, FieldType } from '@margin/pdf-core'

const page: PageState = {
  id: 'p1', sourceId: 'src-0', sourceIndex: 0,
  geometry: { cropBox: [0, 0, 612, 792], rotate: 0 },
}

function seed() {
  const s = useEditsStore()
  s.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
    { p1: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null } })
  return s
}

/**
 * jsdom ships no PointerEvent constructor, so these are plain Events with
 * the pointer fields assigned -- the same idiom drawShapes.test.ts uses.
 */
function stubRect(el: Element): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, right: 612, bottom: 792, width: 612, height: 792, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect)
}

function pointer(type: string, x: number, y: number): PointerEvent {
  const e = new Event(type, { bubbles: true }) as PointerEvent
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1 })
  return e
}

async function drag(w: ReturnType<typeof mount>, from = [100, 100], to = [300, 140]) {
  const el = w.get('[data-draw-surface]').element
  stubRect(el)
  el.dispatchEvent(pointer('pointerdown', from[0]!, from[1]!))
  window.dispatchEvent(pointer('pointermove', to[0]!, to[1]!))
  window.dispatchEvent(pointer('pointerup', to[0]!, to[1]!))
  await w.vm.$nextTick()
}

const fieldsIn = (s: ReturnType<typeof useEditsStore>): FieldObject[] =>
  Object.values(s.doc.objects).filter((o): o is FieldObject => o.kind === 'field')

async function draw(type: FieldType, times = 1) {
  const s = seed()
  const tools = useToolsStore()
  tools.setTool('field')
  tools.setFieldType(type)
  for (let i = 0; i < times; i++) {
    // Committing hands the new object to the select tool, so the tool is
    // re-armed BEFORE each drag rather than after -- re-arming after the
    // last one would hide exactly that behaviour from the test below.
    tools.setTool('field')
    const w = mount(PageOverlay, { props: { page, zoom: 1 } })
    await drag(w, [100, 100 + i * 60], [300, 140 + i * 60])
    w.unmount()
  }
  return { store: s, fields: fieldsIn(s) }
}

describe('the field tool', () => {
  beforeEach(() => { setActivePinia(createPinia()) })

  it('creates a field object from a drag', async () => {
    const { fields } = await draw('text')
    expect(fields).toHaveLength(1)
    expect(fields[0]!.kind).toBe('field')
    expect(fields[0]!.fieldType).toBe('text')
    expect(fields[0]!.rect.w).toBeCloseTo(200, 0)
  })

  it('hands the new field to the select tool, already selected', async () => {
    const { store, fields } = await draw('text')
    expect(useToolsStore().active).toBe('select')
    expect(store.selection).toEqual([fields[0]!.id])
  })

  it('is undoable as one step', async () => {
    const { store } = await draw('text')
    store.undo()
    expect(fieldsIn(store)).toHaveLength(0)
  })

  it('draws the type the tool is set to', async () => {
    expect((await draw('dropdown')).fields[0]!.fieldType).toBe('dropdown')
    expect((await draw('signature')).fields[0]!.fieldType).toBe('signature')
  })

  /**
   * Two fields sharing a /T are ONE field holding one value, so a duplicate
   * name is not cosmetic: typing into either would fill both.
   */
  it('gives every field a name no other field has', async () => {
    const { fields } = await draw('text', 3)
    expect(new Set(fields.map((f) => f.name)).size).toBe(3)
  })

  // A checkbox is square in every viewer that renders one, and the
  // two-state appearance is drawn to the widget's own BBox -- a stretched
  // box renders a stretched dot.
  it('makes buttons square regardless of the drag', async () => {
    const { fields } = await draw('checkbox')
    expect(fields[0]!.rect.w).toBe(fields[0]!.rect.h)
  })
})

describe('radio groups from the tool', () => {
  beforeEach(() => { setActivePinia(createPinia()) })

  it('puts consecutive buttons in one group', async () => {
    const { fields } = await draw('radio', 3)
    expect(new Set(fields.map((f) => f.group)).size).toBe(1)
    expect(fields.every((f) => f.group !== null)).toBe(true)
  })

  // Every button in a group shares the group's name as its /T. That IS what
  // makes them one field.
  it('gives every button in a group the same name', async () => {
    const { fields } = await draw('radio', 3)
    expect(new Set(fields.map((f) => f.name)).size).toBe(1)
  })

  /**
   * THE FINDING. mupdf derives a button's identity from its /AP /N keys, so
   * two buttons sharing an export value are ONE button -- toggling either
   * turns on both, silently.
   */
  it('gives every button its own export value', async () => {
    const { fields } = await draw('radio', 3)
    expect(new Set(fields.map((f) => f.exportValue)).size).toBe(3)
  })

  it('never uses "Off" as an export value', async () => {
    const { fields } = await draw('radio', 3)
    expect(fields.some((f) => f.exportValue === 'Off')).toBe(false)
  })
})

/** The naming decisions, unit-tested away from the drag machinery. */
describe('field naming', () => {
  const objects = (fields: Array<Partial<FieldObject>>): Record<string, EditObject> =>
    Object.fromEntries(fields.map((f, i) => [`f${i}`, {
      id: `f${i}`, pageId: 'p1', kind: 'field', rect: { x: 0, y: 0, w: 10, h: 10 },
      rotation: 0, z: i, locked: false, opacity: 1,
      fieldType: 'text', name: `n${i}`, group: null, exportValue: null,
      value: '', options: [], required: false, readOnly: false,
      multiline: false, maxLength: null, fontSize: 0, ...f,
    } as EditObject]))

  it('names by type, so a page of fields is legible', () => {
    expect(uniqueFieldName({}, 'text')).toBe('text_1')
    expect(uniqueFieldName({}, 'checkbox')).toBe('check_1')
    expect(uniqueFieldName({}, 'dropdown')).toBe('select_1')
  })

  it('skips names already taken', () => {
    expect(uniqueFieldName(objects([{ name: 'text_1' }, { name: 'text_2' }]), 'text')).toBe('text_3')
  })

  it('finds the most recent radio group, and none when there is none', () => {
    expect(currentRadioGroup({})).toBeNull()
    expect(currentRadioGroup(objects([
      { fieldType: 'radio', group: 'a' },
      { fieldType: 'radio', group: 'b' },
    ]))).toBe('b')
  })

  it('keeps export values unique within a group, but not across groups', () => {
    const two = objects([
      { fieldType: 'radio', group: 'a', exportValue: 'option_1' },
      { fieldType: 'radio', group: 'b', exportValue: 'option_1' },
    ])
    expect(uniqueExportValue(two, 'a')).toBe('option_2')
    // A different group is a different field, so its options start again.
    expect(uniqueExportValue(two, 'b')).toBe('option_2')
    expect(uniqueExportValue(objects([]), 'c')).toBe('option_1')
  })

  it('gives a non-radio field no group and no export value', () => {
    expect(newFieldNames({}, 'text')).toEqual({ name: 'text_1', group: null, exportValue: null })
  })
})
