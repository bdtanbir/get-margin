import * as mupdf from 'mupdf'
import type { Rect } from '@margin/transform'
import type { FieldValue } from './types.js'

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

/** Whether the document declares a form at all. */
export function hasAcroForm(raw: mupdf.PDFDocument): boolean {
  const root = raw.getTrailer().get('Root')
  if (!root.isDictionary()) return false
  const acro = root.get('AcroForm')
  if (!acro.isDictionary()) return false
  const fields = acro.get('Fields')
  return fields.isArray() && fields.length > 0
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
  // A document with no /AcroForm has no form fields, by the format's own
  // definition -- widgets outside it are non-conformant and no viewer
  // treats them as a form. One catalog lookup here saves LOADING A PAGE
  // for every page of every document that has no form, which is nearly all
  // of them: the fill overlay asks per page, so without this a 300-page
  // report pays a page load per page for an answer that is always empty.
  // Measured at 41ms per scroll step with this check absent against 36ms
  // with it (docs/findings/10-large-document-performance.md).
  if (!hasAcroForm(raw)) return []

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

/**
 * Write the user's values into fields that already existed in the source.
 *
 * Runs AFTER the object writers, so a value can be set on a field created
 * in the same session -- the field has to exist before it can be filled.
 *
 * A key matching nothing is skipped silently rather than throwing. It means
 * the page carrying that field was deleted after it was filled, which is an
 * ordinary sequence of edits and not an error; failing the export would
 * make an undo the user already performed block their download.
 */
export function applyFieldValues(
  raw: mupdf.PDFDocument,
  values: Record<string, FieldValue>,
  pageRefs: string[],
): void {
  if (Object.keys(values).length === 0) return

  for (let i = 0; i < raw.countPages(); i++) {
    const page = raw.loadPage(i)
    try {
      const widgets = page.getWidgets()
      if (widgets.length === 0) continue

      const annots: mupdf.PDFObject[] = []
      const arr = page.getObject().get('Annots')
      if (arr.isArray()) {
        arr.forEach((a) => {
          if (a.isDictionary() && a.get('Subtype').asName() === 'Widget') annots.push(a)
        })
      }

      widgets.forEach((w, index) => {
        const key = fieldKey(w.getName(), pageRefs[i] ?? `page:${i}`, index)
        if (!(key in values)) return
        setWidgetValue(raw, w, annots[index], values[key]!)
      })
    } finally {
      page.destroy()
    }
  }
}

/**
 * Set one widget's value, by type.
 *
 * Buttons go through raw /V and /AS rather than toggle(): toggle flips
 * whatever the current state is, so applying a stored value through it
 * would depend on what the document happened to ship with. Setting the
 * state directly is idempotent, which is what replaying an edit log needs.
 */
function setWidgetValue(
  raw: mupdf.PDFDocument,
  w: mupdf.PDFWidget,
  annot: mupdf.PDFObject | undefined,
  value: FieldValue,
): void {
  if (w.isCheckbox() || w.isRadioButton()) {
    if (!annot) return
    // This button's own on-state, from its /AP /N keys -- "Yes" for a
    // checkbox, the button's export value for a radio kid.
    const on = exportValueOf(annot) ?? 'Yes'

    if (w.isRadioButton()) {
      // A radio group's value NAMES the selected button, and every button
      // in the group shares one key -- so each one has to ask whether the
      // value is its own. Treating the value as "this button is on", the
      // way a checkbox does, turns on every button in the group: they all
      // see the same string and all say yes. That is the same shape as the
      // pre-flight's /AP failure, arrived at from the other direction.
      const chosen = typeof value === 'string' ? value : ''
      annot.put('AS', raw.newName(chosen === on ? on : 'Off'))

      // The value belongs to the FIELD, which for a kid is its parent --
      // which is exactly why a kid's getValue() reports the group's value.
      const parent = annot.get('Parent')
      if (parent.isDictionary()) parent.put('V', raw.newName(chosen === '' ? 'Off' : chosen))
      return
    }

    const selected = value === true || value === on || value === 'Yes'
    const state = selected ? on : 'Off'
    annot.put('AS', raw.newName(state))
    annot.put('V', raw.newName(state))
    return
  }

  if (w.isChoice()) {
    const v = Array.isArray(value) ? value[0] : value
    if (typeof v === 'string') w.setChoiceValue(v)
    return
  }

  if (typeof value === 'string') w.setTextValue(value)
}
