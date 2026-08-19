import * as mupdf from 'mupdf'
import type { Rect } from '@margin/transform'

/**
 * A form field that ALREADY EXISTS in a source document.
 *
 * Distinct from FieldObject, which is a field the user created. This one is
 * read-only structure: the user supplies a value and nothing else. See
 * PHASE-5-DESIGN.md 0 for why the two are not one type.
 */
export type SourceFieldType =
  | 'text' | 'checkbox' | 'radio' | 'dropdown' | 'listbox' | 'signature' | 'button'

export type SourceField = {
  /** The key into EditDocument.fieldValues. */
  key: string
  name: string
  type: SourceFieldType
  /**
   * MuPDF page space (Convention A): top-down, CropBox origin normalised,
   * /Rotate applied. This is the RENDERER's space, so the DOM overlay
   * positions with the same transform every other layer uses and needs no
   * conversion. Measured in docs/findings/12-phase-5-preflight.md 4.
   */
  rect: Rect
  /** The field's value. For a radio button this is the GROUP's value. */
  value: string
  /**
   * This button's own on-state, or 'Off'. Null for non-buttons.
   *
   * Exists because `value` above is the group's, not the button's --
   * findings 12 3. Every kid in a group reports the selected option, so a
   * UI rendering "checked" from `value` shows every option as chosen. This
   * is read from the raw /AS.
   */
  state: string | null
  /** A button's on-state name, from its /AP /N keys. Null for non-buttons. */
  exportValue: string | null
  options: string[]
  readOnly: boolean
  required: boolean
  multiline: boolean
  maxLength: number | null
}

/**
 * The fieldValues key for a field.
 *
 * Named fields key by name, so that two widgets sharing a /T -- which are
 * ONE field in PDF semantics -- share a value without anything having to
 * keep them in step.
 *
 * Unnamed fields are structurally invalid but do occur, and they key
 * positionally off the SOURCE page rather than the document page. A source
 * page's widget order is fixed; a document page can be reordered, deleted,
 * or duplicated, and two document pages cloned from one source page are
 * showing the same underlying widget.
 */
export function fieldKey(name: string, pageRef: string, index: number): string {
  return name.trim() === '' ? `#unnamed:${pageRef}#${index}` : name
}

const FIELD_TYPES: Record<string, SourceFieldType> = {
  text: 'text',
  checkbox: 'checkbox',
  radiobutton: 'radio',
  combobox: 'dropdown',
  listbox: 'listbox',
  signature: 'signature',
  button: 'button',
}

/** A widget's on-state: the /AP /N key that is not 'Off'. */
function exportValueOf(annot: mupdf.PDFObject): string | null {
  const ap = annot.get('AP')
  if (!ap.isDictionary()) return null
  const n = ap.get('N')
  if (!n.isDictionary()) return null
  let found: string | null = null
  n.forEach((_v, k) => {
    const key = String(k)
    if (key !== 'Off' && found === null) found = key
  })
  return found
}

/**
 * Every form field on one page of an opened document.
 *
 * `pageRef` identifies the SOURCE page -- the caller passes something like
 * `src-0:3` -- and is used only to key unnamed fields.
 *
 * Reads structure through the widget API where it exists and drops to raw
 * objects where it does not: /AS has no accessor, and it is the only honest
 * answer to "is THIS button the selected one".
 */
export function listFields(
  raw: mupdf.PDFDocument,
  pageIndex: number,
  pageRef: string,
): SourceField[] {
  const page = raw.loadPage(pageIndex)
  try {
    const annots = page.getObject().get('Annots')
    // Widget order and /Annots order are the same, but only /Annots carries
    // the raw dictionaries, so they are walked in parallel rather than
    // assuming an index mapping between two different APIs.
    const rawByIndex: mupdf.PDFObject[] = []
    if (annots.isArray()) {
      annots.forEach((a) => {
        if (a.isDictionary() && a.get('Subtype').asName() === 'Widget') rawByIndex.push(a)
      })
    }

    return page.getWidgets().map((w, i) => {
      const obj = rawByIndex[i]
      const type = FIELD_TYPES[w.getFieldType()] ?? 'text'
      const isButton = type === 'checkbox' || type === 'radio'
      const [x0, y0, x1, y1] = w.getBounds()
      const name = w.getName()

      return {
        key: fieldKey(name, pageRef, i),
        name,
        type,
        rect: { x: x0!, y: y0!, w: x1! - x0!, h: y1! - y0! },
        value: w.getValue(),
        state: isButton && obj && obj.get('AS').isName() ? obj.get('AS').asName() : null,
        exportValue: isButton && obj ? exportValueOf(obj) : null,
        options: type === 'dropdown' || type === 'listbox' ? w.getOptions() : [],
        readOnly: w.isReadOnly(),
        required: (w.getFieldFlags() & 2) === 2,
        multiline: w.isMultiline(),
        maxLength: w.getMaxLen() > 0 ? w.getMaxLen() : null,
      }
    })
  } finally {
    page.destroy()
  }
}
