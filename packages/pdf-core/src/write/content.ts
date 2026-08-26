import * as mupdf from 'mupdf'
import { num } from './coords.js'
import type { Color } from './types.js'

/**
 * Marks the bracket this module adds, so a page is wrapped once however
 * many fragments are appended to it. Without it, every writer on a page
 * would add another layer of nesting.
 */
const GUARD = 'MarginContentGuard'

/** Whether this page's content has already been bracketed by us. */
function isGuarded(contents: mupdf.PDFObject): boolean {
  if (!contents.isArray() || contents.length === 0) return false
  const first = contents.get(0)
  return first.isStream() && !first.get(GUARD).isNull()
}

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
 * THE PAGE'S OWN CONTENT IS WRAPPED TOO, and that is not defensive
 * tidiness -- it is load-bearing. The /Contents array is one stream as far
 * as a viewer is concerned, so anything the page leaves applied at the end
 * of its own content applies to whatever is appended next. A leading `q`
 * saves OUR state; it cannot undo a transform the page pushed and never
 * popped.
 *
 * This file used to assume that could not happen, on the grounds that
 * "every producer of well-formed PDF balances its operators". Chromium does
 * not, and Chromium prints a large share of the PDFs in existence. Its
 * pages open with
 *
 *     .23999999 0 0 -.23999999 0 842.88 cm
 *
 * at the top level, outside any q/Q, so the CTM at the end of the page is a
 * quarter-scale Y-flip. Everything appended after it -- a text patch, a
 * stamp, a whiteout, a shape -- was drawn through that transform and landed
 * scaled down, mirrored, and far from where it was asked to go.
 *
 * Bracketing the original content with q/Q gives every appended fragment
 * the page's initial CTM, which is what all of the geometry in this
 * directory is computed against. The original bytes are untouched: the
 * brackets are separate streams around them.
 */
export function appendContent(
  raw: mupdf.PDFDocument,
  page: mupdf.PDFPage,
  ops: string,
): void {
  const stream = raw.addStream(`q\n${ops}\nQ\n`, {})
  const pageObj = page.getObject()
  const contents = pageObj.get('Contents')

  // Already bracketed: everything after the closing Q starts from the
  // page's initial CTM, so this can simply join the queue.
  if (isGuarded(contents)) {
    contents.push(stream)
    return
  }

  const open = raw.addStream('q\n', { [GUARD]: 'open' })
  const close = raw.addStream('\nQ\n', {})

  const array = raw.newArray()
  array.push(open)
  if (contents.isArray()) {
    for (let i = 0; i < contents.length; i++) array.push(contents.get(i))
  } else if (!contents.isNull()) {
    array.push(contents)
  }
  array.push(close)
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
