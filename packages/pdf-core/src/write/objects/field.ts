import * as mupdf from 'mupdf'
import type { ObjectWriter, WriteContext } from '../index.js'
import type { FieldObject } from '../types.js'
import { toContentSpace } from '../coords.js'
import { twoStateAppearance } from '../fieldAppearance.js'

/**
 * Field flag bits, named rather than spelled as numbers at the call site.
 *
 * Read off the build in docs/findings/12-phase-5-preflight.md 6 rather than
 * copied from a table, because `PDFWidget` exposes them as statics and a
 * transcription error here produces a field that is subtly the wrong kind.
 */
export const FIELD_READ_ONLY = 1
export const FIELD_REQUIRED = 2
export const TX_MULTILINE = 1 << 12
export const BTN_NO_TOGGLE_OFF = 1 << 14
export const BTN_RADIO = 1 << 15
export const CH_COMBO = 1 << 17

/**
 * The document-wide form dictionary, created once and then reused.
 *
 * IDEMPOTENT, and that is the whole point: a source document may already
 * have an /AcroForm holding the fields the user is editing, and replacing
 * it would silently destroy every one of them. A document that has one
 * keeps it; a document that does not gets the minimum a viewer needs to
 * render a field at all.
 *
 * /DR carries Helvetica because /DA names it. A field whose default
 * appearance references a font the resource dictionary does not have is
 * valid on paper and blank on screen.
 */
export function ensureAcroForm(raw: mupdf.PDFDocument): mupdf.PDFObject {
  const root = raw.getTrailer().get('Root')
  const existing = root.get('AcroForm')
  if (existing.isDictionary()) {
    // Even an existing form may lack /Fields -- a document whose fields
    // were all deleted by another tool, for instance.
    if (!existing.get('Fields').isArray()) existing.put('Fields', raw.newArray())
    return existing
  }

  const acro = raw.newDictionary()
  acro.put('Fields', raw.newArray())
  acro.put('DA', raw.newString('/Helv 0 Tf 0 g'))

  const helv = raw.newDictionary()
  helv.put('Type', raw.newName('Font'))
  helv.put('Subtype', raw.newName('Type1'))
  helv.put('BaseFont', raw.newName('Helvetica'))
  const fonts = raw.newDictionary()
  fonts.put('Helv', raw.addObject(helv))
  const dr = raw.newDictionary()
  dr.put('Font', fonts)
  acro.put('DR', dr)

  const ref = raw.addObject(acro)
  root.put('AcroForm', ref)
  return ref
}

/** The page's /Annots array, created if the page has none. */
export function pageAnnots(raw: mupdf.PDFDocument, page: mupdf.PDFPage): mupdf.PDFObject {
  const obj = page.getObject()
  if (!obj.get('Annots').isArray()) obj.put('Annots', raw.newArray())
  return obj.get('Annots')
}

/**
 * The flags common to every field type.
 *
 * `multiline` is deliberately not applied here: it is a /Tx-only bit and
 * setting it on a button would make a checkbox that no viewer agrees about.
 */
export function commonFlags(o: FieldObject): number {
  return (o.readOnly ? FIELD_READ_ONLY : 0) | (o.required ? FIELD_REQUIRED : 0)
}

/**
 * The widget half of a field: the part that has a position on a page.
 *
 * /Rect is CONVENTION B -- raw PDF user space, bottom-up, CropBox origin
 * NOT normalised -- and therefore goes through toContentSpace, the
 * identity, rather than toAnnotSpace.
 *
 * This is the opposite of what every other annotation in this codebase
 * does, and the distinction is not the annotation: it is the API. Convention
 * A belongs to mupdf's SETTERS -- setRect, setQuadPoints, createLink -- which
 * flip y and normalise the CropBox on the caller's behalf. Writing /Rect as
 * a raw PDF object bypasses all of that and lands in the file exactly as
 * given, so it must be given the file's own space.
 *
 * findings 12 4 measured the direction: a /Rect of [10,20,110,45] written
 * raw reads back from getBounds() as [10,747,110,772] on a 792pt page.
 * getBounds converts B to A; nothing converts on the way in.
 *
 * Sending Convention A here instead puts a field meant for the bottom of
 * the page at the top -- still inside the page box, so a containment
 * assertion passes and only an exact one catches it. That is how this was
 * found.
 *
 * /F 4 is the Print flag. Without it the field renders on screen and
 * vanishes from the printed page, which is a bug nobody finds until they
 * have printed the form.
 */
export function newWidget(ctx: WriteContext, o: FieldObject): mupdf.PDFObject {
  const w = ctx.raw.newDictionary()
  w.put('Type', ctx.raw.newName('Annot'))
  w.put('Subtype', ctx.raw.newName('Widget'))
  w.put('F', 4)

  const r = toContentSpace(o.rect)
  const rect = ctx.raw.newArray()
  for (const n of [r.x, r.y, r.x + r.w, r.y + r.h]) rect.push(n)
  w.put('Rect', rect)
  return w
}

/**
 * A text field.
 *
 * The widget and the field dictionary are ONE object here rather than two.
 * The format allows either, and merging them is what every real-world
 * single-widget field does -- splitting them would mean a /Parent chain for
 * no gain. Radio groups are the exception and genuinely need both.
 */
function writeTextField(ctx: WriteContext, o: FieldObject): void {
  const acro = ensureAcroForm(ctx.raw)
  const w = newWidget(ctx, o)

  w.put('FT', ctx.raw.newName('Tx'))
  w.put('T', ctx.raw.newString(o.name))
  w.put('DA', ctx.raw.newString(`/Helv ${o.fontSize} Tf 0 g`))
  w.put('Ff', commonFlags(o) | (o.multiline ? TX_MULTILINE : 0))

  if (typeof o.value === 'string' && o.value !== '') {
    w.put('V', ctx.raw.newString(o.value))
  }
  if (o.maxLength !== null) w.put('MaxLen', o.maxLength)

  const ref = ctx.raw.addObject(w)
  acro.get('Fields').push(ref)
  pageAnnots(ctx.raw, ctx.page).push(ref)
}

/**
 * A black border, without which an unchecked box renders invisibly.
 *
 * Phase 0's finding, and still a live trap: the field is structurally
 * correct and simply blank, so it reads as a missing control rather than an
 * empty one.
 */
function putBorder(raw: mupdf.PDFDocument, w: mupdf.PDFObject): void {
  const mk = raw.newDictionary()
  const bc = raw.newArray()
  bc.push(0)
  mk.put('BC', bc)
  w.put('MK', mk)
}

/** A checkbox: a single two-state button, on-state "Yes". */
function writeCheckbox(ctx: WriteContext, o: FieldObject): void {
  const acro = ensureAcroForm(ctx.raw)
  const w = newWidget(ctx, o)
  const on = o.value === true

  w.put('FT', ctx.raw.newName('Btn'))
  w.put('T', ctx.raw.newString(o.name))
  w.put('Ff', commonFlags(o))
  w.put('V', ctx.raw.newName(on ? 'Yes' : 'Off'))
  w.put('AS', ctx.raw.newName(on ? 'Yes' : 'Off'))
  putBorder(ctx.raw, w)
  w.put('AP', twoStateAppearance(ctx.raw, o.rect.w, o.rect.h, 'Yes'))

  const ref = ctx.raw.addObject(w)
  acro.get('Fields').push(ref)
  pageAnnots(ctx.raw, ctx.page).push(ref)
}

/**
 * The parent field of a radio group, found if it exists and created if not.
 *
 * Looked up by scanning /AcroForm /Fields rather than threaded through the
 * write context, because the writer contract is one call per object and a
 * group's buttons may be spread across pages. The scan is O(fields) per
 * button, on a document that has at most a handful.
 */
function radioParent(ctx: WriteContext, group: string): mupdf.PDFObject {
  const acro = ensureAcroForm(ctx.raw)
  const fields = acro.get('Fields')

  let found: mupdf.PDFObject | null = null
  fields.forEach((f) => {
    if (found) return
    if (f.isDictionary() && f.get('T').isString() && f.get('T').asString() === group) found = f
  })
  if (found) return found

  const parent = ctx.raw.newDictionary()
  parent.put('FT', ctx.raw.newName('Btn'))
  parent.put('T', ctx.raw.newString(group))
  parent.put('Ff', BTN_RADIO | BTN_NO_TOGGLE_OFF)
  parent.put('V', ctx.raw.newName('Off'))
  parent.put('Kids', ctx.raw.newArray())
  const ref = ctx.raw.addObject(parent)
  fields.push(ref)
  return ref
}

/**
 * One button of a radio group.
 *
 * Unlike every other type here, the field and the widget are separate
 * objects: the group is one field with N kid widgets, which is what makes
 * the buttons mutually exclusive. Only the PARENT goes in /AcroForm
 * /Fields; the kids go in the page's /Annots.
 *
 * The /AP is not decoration. mupdf reads a kid's on-state name from the
 * keys of its /AP /N dictionary, so this is where the button's identity
 * lives -- see fieldAppearance.ts and findings 12 1 for what happens
 * without it, which is that every button in the group becomes the same
 * button and toggling one turns on all of them, silently.
 */
function writeRadio(ctx: WriteContext, o: FieldObject): void {
  const group = o.group ?? o.name
  const state = o.exportValue ?? o.id
  if (state === 'Off') {
    // "Off" is the universal unselected state; a button claiming it as its
    // ON state can never be distinguished from being off.
    throw new Error('a radio button cannot use "Off" as its export value')
  }

  const parent = radioParent(ctx, group)
  const kid = newWidget(ctx, o)
  kid.put('Parent', parent)
  kid.put('AS', ctx.raw.newName(o.value === true ? state : 'Off'))
  putBorder(ctx.raw, kid)
  kid.put('AP', twoStateAppearance(ctx.raw, o.rect.w, o.rect.h, state))

  const ref = ctx.raw.addObject(kid)
  parent.get('Kids').push(ref)
  pageAnnots(ctx.raw, ctx.page).push(ref)

  // The group's value lives on the parent, which is why a kid's own
  // getValue() reports it (findings 12 3).
  if (o.value === true) parent.put('V', ctx.raw.newName(state))
}

/**
 * A dropdown or a list box.
 *
 * The two differ by one flag. A combo box shows one row and opens; a list
 * box shows several at once. Same field type, same options, same value.
 */
function writeChoice(ctx: WriteContext, o: FieldObject): void {
  const acro = ensureAcroForm(ctx.raw)
  const w = newWidget(ctx, o)

  w.put('FT', ctx.raw.newName('Ch'))
  w.put('T', ctx.raw.newString(o.name))
  w.put('DA', ctx.raw.newString(`/Helv ${o.fontSize} Tf 0 g`))
  w.put('Ff', commonFlags(o) | (o.fieldType === 'dropdown' ? CH_COMBO : 0))

  const opt = ctx.raw.newArray()
  for (const option of o.options) opt.push(ctx.raw.newString(option))
  w.put('Opt', opt)

  // A value that is not one of the options would be a field no viewer can
  // display consistently, so it is dropped rather than written.
  if (typeof o.value === 'string' && o.options.includes(o.value)) {
    w.put('V', ctx.raw.newString(o.value))
  }

  const ref = ctx.raw.addObject(w)
  acro.get('Fields').push(ref)
  pageAnnots(ctx.raw, ctx.page).push(ref)
}

/**
 * A signature field: a PLACE for a signature, and not a signature.
 *
 * /FT /Sig with no /V. get-margin does not do cryptographic signing, and a
 * field that carried anything resembling a signature value would be a
 * meaningful lie about what the document asserts. What this creates is the
 * box another tool -- or a pen, after printing -- fills in.
 */
function writeSignatureField(ctx: WriteContext, o: FieldObject): void {
  const acro = ensureAcroForm(ctx.raw)
  const w = newWidget(ctx, o)

  w.put('FT', ctx.raw.newName('Sig'))
  w.put('T', ctx.raw.newString(o.name))
  w.put('Ff', commonFlags(o))
  putBorder(ctx.raw, w)

  const ref = ctx.raw.addObject(w)
  acro.get('Fields').push(ref)
  pageAnnots(ctx.raw, ctx.page).push(ref)
}

/**
 * One writer for every field type, dispatched on `fieldType`.
 *
 * Unlike the shape writers, these do not share an implementation -- a
 * checkbox and a dropdown have almost nothing in common at the object
 * level. What they share is the wiring above.
 */
export const writeField: ObjectWriter = (ctx, object) => {
  const o = object as FieldObject
  if (o.name.trim() === '') {
    // A field with no /T cannot hold a value: the format addresses values
    // by name. Failing here names the object; letting it through produces
    // a form that silently discards what the user types into it.
    throw new Error('a form field needs a name')
  }

  switch (o.fieldType) {
    case 'text':
      writeTextField(ctx, o)
      return
    case 'checkbox':
      writeCheckbox(ctx, o)
      return
    case 'radio':
      writeRadio(ctx, o)
      return
    case 'dropdown':
    case 'listbox':
      writeChoice(ctx, o)
      return
    case 'signature':
      writeSignatureField(ctx, o)
      return
    default:
      throw new Error(`unsupported field type "${o.fieldType as string}"`)
  }
}
