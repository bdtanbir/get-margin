import * as mupdf from 'mupdf'
import type { ObjectWriter, WriteContext } from '../index.js'
import type { FieldObject } from '../types.js'
import { toContentSpace } from '../coords.js'

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
    default:
      throw new Error(`unsupported field type "${o.fieldType}"`)
  }
}
