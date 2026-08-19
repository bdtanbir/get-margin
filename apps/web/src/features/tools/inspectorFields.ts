import type { EditObject, FieldObject } from '@margin/pdf-core'
import { FONTS } from '@/lib/fonts'
import { normalizeUri } from '@/lib/linkUrl'

export type Field =
  | { key: string; label: string; type: 'number'; min: number; max: number; step: number }
  | { key: string; label: string; type: 'color' }
  | {
      key: string; label: string; type: 'text'
      /**
       * Applied when the edit is COMMITTED (change/blur), not on every
       * keystroke -- normalising mid-typing would fight the caret. Throwing
       * rejects the edit and surfaces the message, which is how a
       * `javascript:` URL stays unrepresentable in the edit document.
       */
      normalize?: (value: string) => string
    }
  | { key: string; label: string; type: 'select'; options: Array<{ value: string; label: string }> }
  | { key: string; label: string; type: 'boolean' }
  /** A list the user adds to and removes from -- a choice field's options. */
  | { key: string; label: string; type: 'list' }
  /** Static text. `key` is unused, but keeps the render loop uniform. */
  | { key: string; label: string; type: 'note'; text: string }

const OPACITY: Field = { key: 'opacity', label: 'Opacity', type: 'number', min: 0, max: 1, step: 0.05 }
const ROTATION: Field = { key: 'rotation', label: 'Rotation', type: 'number', min: -180, max: 180, step: 1 }

const SHAPE: Field[] = [
  { key: 'stroke', label: 'Stroke', type: 'color' },
  { key: 'strokeWidth', label: 'Stroke width', type: 'number', min: 0, max: 24, step: 0.5 },
  { key: 'fill', label: 'Fill', type: 'color' },
  OPACITY, ROTATION,
]

const TEXT: Field[] = [
  {
    key: 'fontFamily', label: 'Font', type: 'select',
    // Built from the curated set rather than hardcoded: a font added to
    // lib/fonts.ts must appear in the picker, or it exists only to whoever
    // reads the source.
    options: FONTS.map((f) => ({ value: f.family, label: f.family })),
  },
  { key: 'fontSize', label: 'Size', type: 'number', min: 4, max: 144, step: 1 },
  { key: 'color', label: 'Colour', type: 'color' },
  {
    key: 'align', label: 'Align', type: 'select',
    options: [
      { value: 'left', label: 'Left' },
      { value: 'center', label: 'Centre' },
      { value: 'right', label: 'Right' },
    ],
  },
  OPACITY, ROTATION,
]

/**
 * A form field's properties, which depend on the field's TYPE and not only
 * on its kind -- options belong to a dropdown and nowhere else, multiline to
 * a text field and nowhere else. Offering every property for every type
 * would put "Options" on a checkbox, which is not a setting so much as a
 * question with no answer.
 */
function formField(o: FieldObject): Field[] {
  const fields: Field[] = [
    {
      key: 'fieldType', label: 'Type', type: 'select',
      options: [
        { value: 'text', label: 'Text' },
        { value: 'checkbox', label: 'Checkbox' },
        { value: 'radio', label: 'Radio button' },
        { value: 'dropdown', label: 'Dropdown' },
        { value: 'listbox', label: 'List box' },
        { value: 'signature', label: 'Signature' },
      ],
    },
    {
      key: 'name', label: 'Name', type: 'text',
      // A field with no /T cannot hold a value: the format addresses values
      // BY name. Rejecting it here means the export never has to.
      normalize: (v: string) => {
        if (v.trim() === '') throw new Error('A form field needs a name.')
        return v.trim()
      },
    },
  ]

  if (o.fieldType === 'radio') {
    fields.push({
      key: 'exportValue', label: 'Option value', type: 'text',
      // Two buttons sharing an export value are ONE button: mupdf derives a
      // button's identity from its /AP /N keys, and toggling either would
      // turn on both. "Off" is the universal unselected state.
      normalize: (v: string) => {
        const t = v.trim()
        if (t === '') throw new Error('A radio button needs an option value.')
        if (t === 'Off') throw new Error('"Off" is reserved for an unselected button.')
        return t
      },
    })
  }

  if (o.fieldType === 'dropdown' || o.fieldType === 'listbox') {
    fields.push({ key: 'options', label: 'Options', type: 'list' })
  }

  if (o.fieldType === 'text') {
    fields.push({ key: 'multiline', label: 'Multiple lines', type: 'boolean' })
    fields.push({ key: 'maxLength', label: 'Max length', type: 'number', min: 0, max: 4096, step: 1 })
  }

  if (o.fieldType === 'signature') {
    fields.push({
      key: 'note', label: '', type: 'note',
      // Said plainly, because the alternative is a user believing this app
      // signs documents. It places a box for a signature; it does not sign.
      text: 'A place for a signature. get-margin does not sign documents.',
    })
  }

  if (o.fieldType !== 'signature') {
    fields.push({ key: 'required', label: 'Required', type: 'boolean' })
    fields.push({ key: 'readOnly', label: 'Read only', type: 'boolean' })
  }

  return fields
}

/**
 * Kind -> editable fields. Adding a field here is all a tool task needs to
 * do to make it editable; the Inspector renders whatever this returns, so no
 * tool ships its own bespoke panel.
 */
const REGISTRY: Partial<Record<EditObject['kind'], Field[]>> = {
  rect: SHAPE, ellipse: SHAPE, line: SHAPE, arrow: SHAPE,
  text: TEXT,
  whiteout: [{ key: 'fill', label: 'Colour', type: 'color' }, OPACITY],
  ink: [
    { key: 'color', label: 'Colour', type: 'color' },
    { key: 'strokeWidth', label: 'Thickness', type: 'number', min: 0.5, max: 24, step: 0.5 },
    OPACITY,
  ],
  highlight: [{ key: 'color', label: 'Colour', type: 'color' }, OPACITY],
  underline: [{ key: 'color', label: 'Colour', type: 'color' }, OPACITY],
  strikeout: [{ key: 'color', label: 'Colour', type: 'color' }, OPACITY],
  link: [{ key: 'uri', label: 'URL', type: 'text', normalize: normalizeUri }],
  image: [OPACITY, ROTATION],
  signature: [OPACITY, ROTATION],
}

/**
 * Takes the OBJECT, not just its kind: a form field's properties depend on
 * its fieldType, and every other kind ignores the argument entirely.
 */
export function fieldsFor(object: EditObject): Field[] {
  if (object.kind === 'field') return formField(object)
  return REGISTRY[object.kind] ?? []
}
