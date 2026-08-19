import * as mupdf from 'mupdf'
import { num } from './coords.js'
import type { Color } from './types.js'

/**
 * Append a content-stream fragment to a page, without disturbing what is
 * already drawn there.
 *
 * /Contents may legally be either a single stream or an array of streams
 * that the viewer concatenates. Appending to the array form is the safe
 * edit: rewriting the existing stream would mean decoding, splicing, and
 * re-encoding content this application has no reason to touch. When the page
 * carries a single stream we promote it to a one-element array first.
 *
 * Every fragment is wrapped in q/Q so a writer that leaves the graphics
 * state dirty cannot corrupt whatever is appended after it.
 *
 * NOTE ON THE PRECEDING STREAM: the concatenation of the /Contents array is
 * a single stream as far as the viewer is concerned, so a page whose own
 * content ends mid-path or with an unbalanced `q` would poison this
 * fragment. The leading `q` protects the fragment's graphics state but not
 * its current transformation matrix if the page left one pushed; MuPDF's
 * own writers make the same assumption, and every producer of well-formed
 * PDF balances its operators.
 */
export function appendContent(
  raw: mupdf.PDFDocument,
  page: mupdf.PDFPage,
  ops: string,
): void {
  const stream = raw.addStream(`q\n${ops}\nQ\n`, {})
  const pageObj = page.getObject()
  const contents = pageObj.get('Contents')

  if (contents.isArray()) {
    contents.push(stream)
    return
  }

  const array = raw.newArray()
  if (!contents.isNull()) array.push(contents)
  array.push(stream)
  pageObj.put('Contents', array)
}

/**
 * The same, but UNDER everything already on the page.
 *
 * A watermark drawn over a photograph is unreadable and one drawn under it
 * is invisible, so both are wanted and neither is the obvious default --
 * this is the half the ordinary append cannot express.
 *
 * The existing content is not modified: a new array is built with this
 * stream first. PDF concatenates a /Contents array into one stream, so
 * position in the array IS paint order.
 */
export function prependContent(
  raw: mupdf.PDFDocument,
  page: mupdf.PDFPage,
  ops: string,
): void {
  const stream = raw.addStream(`q\n${ops}\nQ\n`, {})
  const pageObj = page.getObject()
  const contents = pageObj.get('Contents')

  const array = raw.newArray()
  array.push(stream)
  if (contents.isArray()) {
    contents.forEach((entry) => array.push(entry))
  } else if (!contents.isNull()) {
    array.push(contents)
  }
  pageObj.put('Contents', array)
}

/**
 * Register a resource under /Resources/<category>/<name>, creating the
 * intermediate dictionaries when the page has none. Returns the name the
 * content stream should reference.
 *
 * Names are caller-supplied and must be unique per page; writers derive them
 * from the object id, which nanoid already guarantees is unique.
 */
export function addResource(
  raw: mupdf.PDFDocument,
  page: mupdf.PDFPage,
  category: 'XObject' | 'Font' | 'ExtGState',
  name: string,
  value: mupdf.PDFObject,
): string {
  const pageObj = page.getObject()
  let resources = pageObj.get('Resources')
  if (!resources.isDictionary()) {
    resources = raw.newDictionary()
    pageObj.put('Resources', resources)
  }
  let bucket = resources.get(category)
  if (!bucket.isDictionary()) {
    bucket = raw.newDictionary()
    resources.put(category, bucket)
  }
  bucket.put(name, value)
  return name
}

/** `0.2 0.4 1 rg` — non-stroking colour. */
export function fillColor(c: Color): string {
  return `${num(c[0])} ${num(c[1])} ${num(c[2])} rg`
}

/** `0.2 0.4 1 RG` — stroking colour. */
export function strokeColor(c: Color): string {
  return `${num(c[0])} ${num(c[1])} ${num(c[2])} RG`
}

/**
 * Constant alpha via an ExtGState. PDF has no inline opacity operator, so
 * transparency always costs a resource entry.
 */
export function alphaState(
  raw: mupdf.PDFDocument,
  page: mupdf.PDFPage,
  name: string,
  opacity: number,
): string {
  const gs = raw.newDictionary()
  gs.put('Type', raw.newName('ExtGState'))
  gs.put('ca', opacity)
  gs.put('CA', opacity)
  addResource(raw, page, 'ExtGState', name, raw.addObject(gs))
  return `/${name} gs`
}
