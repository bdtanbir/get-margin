import type { EditObject, FieldObject, FieldType } from '@margin/pdf-core'

/** Every field object in the document, in a stable order. */
function fieldsOf(objects: Record<string, EditObject>): FieldObject[] {
  return Object.values(objects)
    .filter((o): o is FieldObject => o.kind === 'field')
    .sort((a, b) => a.z - b.z)
}

const PREFIX: Record<FieldType, string> = {
  text: 'text',
  checkbox: 'check',
  radio: 'choice',
  dropdown: 'select',
  listbox: 'list',
  signature: 'signature',
}

/**
 * A field name not already taken.
 *
 * Names are the format's addressing mechanism -- two fields sharing a /T
 * are ONE field and hold one value -- so a duplicate is not a cosmetic
 * problem: typing into either would fill both. The user can rename freely
 * afterwards; this only has to be a defensible starting point.
 */
export function uniqueFieldName(objects: Record<string, EditObject>, type: FieldType): string {
  const taken = new Set(fieldsOf(objects).map((f) => f.name))
  const prefix = PREFIX[type]
  for (let n = 1; ; n++) {
    const name = `${prefix}_${n}`
    if (!taken.has(name)) return name
  }
}

/**
 * The radio group a newly-drawn button should join.
 *
 * Consecutive radio buttons join the most recently created group, because
 * that is what drawing three buttons in a row means. Starting a NEW group
 * is done by renaming it in the inspector -- an explicit act, since a
 * button that silently started its own group would be a group of one, which
 * is a radio button that cannot be deselected and cannot be compared to
 * anything.
 */
export function currentRadioGroup(objects: Record<string, EditObject>): string | null {
  const radios = fieldsOf(objects).filter((f) => f.fieldType === 'radio')
  return radios.length > 0 ? radios[radios.length - 1]!.group : null
}

/**
 * An on-state name unique within its group.
 *
 * Uniqueness here is load-bearing rather than tidy: mupdf derives a
 * button's identity from its /AP /N keys, so two buttons sharing an export
 * value are ONE button and toggling either turns on both
 * (docs/findings/12-phase-5-preflight.md 1).
 *
 * Never "Off", which is the universal unselected state -- a button claiming
 * it could never be told apart from being off.
 */
export function uniqueExportValue(
  objects: Record<string, EditObject>,
  group: string,
): string {
  const taken = new Set(
    fieldsOf(objects)
      .filter((f) => f.fieldType === 'radio' && f.group === group)
      .map((f) => f.exportValue),
  )
  for (let n = 1; ; n++) {
    const value = `option_${n}`
    if (!taken.has(value)) return value
  }
}

/** The whole naming decision for one newly-drawn field. */
export function newFieldNames(
  objects: Record<string, EditObject>,
  type: FieldType,
): { name: string; group: string | null; exportValue: string | null } {
  if (type !== 'radio') {
    return { name: uniqueFieldName(objects, type), group: null, exportValue: null }
  }
  const group = currentRadioGroup(objects) ?? uniqueFieldName(objects, 'radio')
  // Every button in a group shares the group's name as its /T: that is what
  // makes them one field.
  return { name: group, group, exportValue: uniqueExportValue(objects, group) }
}
