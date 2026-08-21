import type { EditObject, FieldObject } from '@margin/pdf-core'
import { FONTS } from '@/lib/fonts'
import { normalizeUri } from '@/lib/linkUrl'

export type Field =
  | {
      key: string; label: string; type: 'number'; min: number; max: number; step: number
      /**
       * How many DISPLAY units one stored unit is worth, when the two differ.
       * Opacity is the case: the format stores 0..1 (/CA, and every writer
       * and golden below it), while "0.15" in a box is a number the reader
       * has to translate and 15 is one they just read.
       *
       * Declared on the field rather than special-cased in the Inspector, so
       * the read and the write can never disagree about the unit.
       */
      scale?: number
    }
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

const OPACITY: Field = {
  key: 'opacity', label: 'Opacity', type: 'number',
  min: 0, max: 100, step: 5, scale: 100,
}

/**
 * A stored value in the units the field SHOWS.
 *
 * Rounded to two decimals because floating point turns 0.29 * 100 into
 * 28.999999999999996, and a box reading that is worse than the decimal it
 * replaced. Two decimals is finer than any step offered, so nothing a user
 * can type is lost on the way back.
 */
export function toDisplay(field: Field, stored: unknown): unknown {
  if (field.type !== 'number' || !field.scale || typeof stored !== 'number') return stored
  return Number((stored * field.scale).toFixed(2))
}

/** The inverse: what the user typed, in the units the document stores. */
export function fromDisplay(field: Field, shown: number): number {
  return field.type === 'number' && field.scale ? shown / field.scale : shown
}
const ROTATION: Field = { key: 'rotation', label: 'Rotation', type: 'number', min: -180, max: 180, step: 1 }

const SHAPE: Field[] = [
  { key: 'stroke', label: 'Stroke', type: 'color' },
  { key: 'strokeWidth', label: 'Stroke width', type: 'number', min: 0, max: 24, step: 0.5 },
  { key: 'fill', label: 'Fill', type: 'color' },
  OPACITY, ROTATION,
]

/**
 * The font picker, shared by the text tool and the document-text editor.
 *
 * Built from the curated set rather than hardcoded: a font added to
 * lib/fonts.ts must appear in the picker, or it exists only to whoever
 * reads the source.
 */
const FONT_FAMILY: Field = {
  key: 'fontFamily', label: 'Font', type: 'select',
  options: FONTS.map((f) => ({ value: f.family, label: f.family })),
}

/**
 * A checkbox, not a weight dropdown.
 *
 * Two weights are bundled -- 400 and 700 -- so a "Weight" select would be a
 * list of two, and a list of two that maps onto on/off is a checkbox
 * wearing a costume. If more weights are ever bundled this becomes a
 * select, and the stored `bold: boolean` becomes the numeric weight it
 * always wanted to be; until the files exist, offering the choice would be
 * offering something the writer can only refuse.
 */
const BOLD: Field = { key: 'bold', label: 'Bold', type: 'boolean' }

/**
 * Its own file, not the regular sheared over.
 *
 * A checkbox for the same reason as BOLD, and beside it rather than folded
 * into a single "Style" picker: the two combine, so a four-option list
 * would be spelling out a product of two independent switches.
 */
const ITALIC: Field = { key: 'italic', label: 'Italic', type: 'boolean' }

const TEXT: Field[] = [
  FONT_FAMILY,
  BOLD,
  ITALIC,
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

  /**
   * A replacement for a line of the DOCUMENT's own text.
   *
   * Deliberately not `TEXT`. Alignment is not offered because a patch has
   * no box of its own to align within -- it redraws a line the document
   * laid out, from that line's own left edge -- so the control would be
   * three choices that all did the same thing.
   *
   * Everything else here is INHERITED from the line being replaced and then
   * made correctable. That is the shape of the whole feature: weight,
   * slope, size, and colour are all read off the line MuPDF extracted, and
   * every one of them used to be decided for the user and decided wrongly
   * -- patches were drawn upright, regular, and black, at a size stored as
   * 0 meaning "work it out at export", which is not a number anybody can
   * edit. The FAMILY is still the user's choice, because `isSerif()` is the
   * one flag MuPDF reports that cannot be trusted on an embedded font.
   *
   * Size steps in halves and reaches down to 1pt rather than the text
   * tool's 4pt floor: document text is routinely smaller than anything
   * anyone would place by hand, and the fine print on a real payment slip
   * sits around 5.
   */
  textPatch: [
    FONT_FAMILY,
    BOLD,
    ITALIC,
    { key: 'fontSize', label: 'Size', type: 'number', min: 1, max: 144, step: 0.5 },
    { key: 'color', label: 'Colour', type: 'color' },
  ],
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
