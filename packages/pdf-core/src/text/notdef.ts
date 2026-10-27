import * as mupdf from 'mupdf'
import { SAVE_OPTIONS } from '../write/session.js'

/**
 * Make the "missing glyph" of every embedded TrueType font draw nothing.
 *
 * Glyph 0 of a TrueType font is `.notdef`: what a renderer draws for a
 * character code the font has no glyph for. MuPDF draws it as the font
 * designed it -- Inter's is a box with "NO GLYPH" written inside -- while
 * Sejda, pdf.js and Acrobat draw nothing. A PDF that shows one is already
 * broken: the case that prompted this was a page whose /F1 had been
 * overwritten by another editor's Inter, so Turnitin's two-byte glyph codes
 * were read as one-byte WinAnsi and every 0x00 byte drew a "NO GLYPH" box
 * between the letters. Other viewers show the same letters without the
 * boxes; this makes ours do the same.
 *
 * Done by pointing glyph 0's `loca` entry at glyph 1's start, which makes
 * its outline zero-length -- its advance width is untouched, so nothing
 * after it moves. One number per font, no table is resized.
 *
 * Used on the document the app DRAWS, and on a download only when a page
 * actually draws a box (see `drawsMissingGlyphs`), so an ordinary file is
 * never rewritten.
 *
 * Fonts are found the way a renderer finds them -- through each page's
 * resources, and the resources of the forms it draws -- never by visiting
 * every object number in the file. That looked simpler and was not: in the
 * Turnitin report, merely resolving every number made the next save drop
 * the page's logo image.
 *
 * TrueType only (/FontFile2, and OpenType with glyf outlines). A CFF or
 * Type 1 `.notdef` is left as it is; those are far rarer in the wild and
 * patching them means rewriting a charstring.
 *
 * Returns how many fonts were changed.
 */
export function blankNotdefGlyphs(doc: mupdf.PDFDocument): number {
  let changed = 0
  for (const file of fontFiles(doc)) {
    try {
      const buffer = file.readStream()
      let patched: Uint8Array | undefined
      try {
        patched = withEmptyNotdef(buffer.asUint8Array())
      } finally {
        buffer.destroy()
      }
      if (patched) {
        file.writeStream(patched)
        changed++
      }
    } catch {
      // A font MuPDF cannot read is MuPDF's to report when the page draws,
      // not ours to fail the open over.
    }
  }
  return changed
}

/**
 * Every embedded TrueType/OpenType font program the pages draw with, each
 * once: through /Resources/Font (following a Type0 to its CID font) and
 * down into form XObjects, which carry resources of their own.
 */
function fontFiles(doc: mupdf.PDFDocument): mupdf.PDFObject[] {
  const files: mupdf.PDFObject[] = []
  const seenFiles = new Set<number>()
  const seenResources = new Set<number>()

  const addDescriptor = (descriptor: mupdf.PDFObject): void => {
    if (!descriptor.isDictionary()) return
    for (const key of ['FontFile2', 'FontFile3']) {
      const file = descriptor.get(key)
      if (!file.isStream() || !file.isIndirect()) continue
      if (seenFiles.has(file.asIndirect())) continue
      seenFiles.add(file.asIndirect())
      files.push(file)
    }
  }

  const walk = (resources: mupdf.PDFObject, depth: number): void => {
    if (!resources.isDictionary() || depth > 8) return
    if (resources.isIndirect()) {
      if (seenResources.has(resources.asIndirect())) return
      seenResources.add(resources.asIndirect())
    }
    const fonts = resources.get('Font')
    if (fonts.isDictionary()) {
      fonts.forEach((font) => {
        if (!font.isDictionary()) return
        addDescriptor(font.get('FontDescriptor'))
        const descendants = font.get('DescendantFonts')
        if (descendants.isArray()) {
          for (let i = 0; i < descendants.length; i++) addDescriptor(descendants.get(i).get('FontDescriptor'))
        }
      })
    }
    const xobjects = resources.get('XObject')
    if (xobjects.isDictionary()) {
      xobjects.forEach((xobject) => {
        if (xobject.isDictionary() && xobject.get('Subtype').isName() && xobject.get('Subtype').asName() === 'Form') {
          walk(xobject.get('Resources'), depth + 1)
        }
      })
    }
  }

  for (let i = 0; i < doc.countPages(); i++) {
    try {
      walk(doc.findPage(i).getInheritable('Resources'), 0)
    } catch {
      // A page whose resources will not resolve draws no fonts to patch.
    }
  }
  return files
}

/**
 * A copy of an sfnt whose glyph 0 has no outline, or nothing if it already
 * has none or the font cannot be read.
 */
export function withEmptyNotdef(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.byteLength < 12) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = view.getUint32(0)
  if (magic !== 0x00010000 && magic !== 0x74727565 && magic !== 0x4f54544f) return undefined
  const numTables = view.getUint16(4)
  let head: number | undefined
  let loca: number | undefined
  let locaLength = 0
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16
    if (record + 16 > bytes.byteLength) return undefined
    const tag = String.fromCharCode(...bytes.subarray(record, record + 4))
    if (tag === 'head') head = view.getUint32(record + 8)
    if (tag === 'loca') { loca = view.getUint32(record + 8); locaLength = view.getUint32(record + 12) }
  }
  if (head === undefined || loca === undefined || head + 54 > bytes.byteLength) return undefined
  const long = view.getInt16(head + 50) === 1
  const size = long ? 4 : 2
  if (locaLength < size * 2 || loca + size * 2 > bytes.byteLength) return undefined
  const read = (at: number): number => (long ? view.getUint32(at) : view.getUint16(at))
  const first = read(loca)
  const second = read(loca + size)
  if (second <= first) return undefined
  const out = bytes.slice()
  const outView = new DataView(out.buffer, out.byteOffset, out.byteLength)
  if (long) outView.setUint32(loca, second)
  else outView.setUint16(loca, second)
  return out
}

/**
 * Whether any page draws a VISIBLE `.notdef` -- a "missing glyph" box.
 *
 * Asked before a download, so that a broken file is repaired on the way out
 * and every other file is left exactly as it was. Cheap where it can be:
 * a box can only come from a glyph MuPDF cannot name, which shows up as
 * U+FFFD in the page's text, so only pages with one are drawn glyph by
 * glyph. Must be asked of a document that has NOT been through
 * `blankNotdefGlyphs`, or every box will already have been emptied.
 */
export function drawsMissingGlyphs(doc: mupdf.PDFDocument): boolean {
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i)
    try {
      const text = page.toStructuredText('')
      let plain: string
      try { plain = text.asText() } finally { text.destroy() }
      if (!plain.includes('\ufffd')) continue
      let found = false
      const walk = (t: mupdf.Text, ctm: mupdf.Matrix): void => {
        if (found) return
        t.walk({
          showGlyph(font, trm, gid, unicode) {
            if (found || gid !== 0) return
            const one = new mupdf.Text()
            try {
              one.showGlyph(font, trm, gid, unicode)
              const [x0, y0, x1, y1] = one.getBounds(null as never, ctm)
              const at = mupdf.Matrix.concat(trm, ctm)
              // The same "reaches past the pen" test as invisible.ts.
              found = x0! < at[4]! - 1.01 || x1! > at[4]! + 1.01 ||
                y0! < at[5]! - 1.01 || y1! > at[5]! + 1.01
            } finally {
              one.destroy()
            }
          },
        })
      }
      const device = new mupdf.Device({
        fillText: walk,
        strokeText: (t, _s, ctm) => walk(t, ctm),
      })
      try {
        page.run(device, mupdf.Matrix.identity)
        device.close()
      } finally {
        device.destroy()
      }
      if (found) return true
    } catch {
      // A page that will not draw is not evidence of a box on it.
    } finally {
      page.destroy()
    }
  }
  return false
}

/**
 * The file to hand back for a download with no edits: the SAME bytes,
 * unless a page draws "missing glyph" boxes, in which case a copy with them
 * emptied. Returns nothing when the original is fine -- an untouched
 * download stays byte-for-byte what was opened.
 *
 * Without this, opening a broken file in the app showed it clean (the
 * viewer empties the boxes) and downloading it handed the boxes straight
 * back, which reads as the download having broken it.
 */
export function repairMissingGlyphs(bytes: Uint8Array): Uint8Array | undefined {
  let doc: mupdf.PDFDocument | undefined
  try {
    doc = mupdf.Document.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument
    // A locked file cannot be read, so cannot be checked; it goes back as is.
    if (doc.needsPassword()) return undefined
    if (!drawsMissingGlyphs(doc)) return undefined
    blankNotdefGlyphs(doc)
    return doc.saveToBuffer(SAVE_OPTIONS).asUint8Array().slice()
  } catch {
    return undefined
  } finally {
    doc?.destroy()
  }
}
