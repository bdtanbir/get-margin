import type * as mupdf from 'mupdf'

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
 * ONLY for a document that is drawn, never one that is saved: it rewrites
 * the font programs in memory. Export opens its own copy from the original
 * bytes (see `replay`), so the user's file is never changed by this.
 *
 * TrueType only (/FontFile2, and OpenType with glyf outlines). A CFF or
 * Type 1 `.notdef` is left as it is; those are far rarer in the wild and
 * patching them means rewriting a charstring.
 *
 * Returns how many fonts were changed.
 */
export function blankNotdefGlyphs(doc: mupdf.PDFDocument): number {
  let changed = 0
  const seen = new Set<number>()
  const count = doc.countObjects()
  for (let num = 1; num < count; num++) {
    try {
      const obj = doc.newIndirect(num).resolve()
      if (!obj.isDictionary() || !obj.get('Type').isName() || obj.get('Type').asName() !== 'FontDescriptor') continue
      for (const key of ['FontFile2', 'FontFile3']) {
        const ref = obj.get(key)
        if (!ref.isStream()) continue
        const id = ref.isIndirect() ? ref.asIndirect() : -num
        if (seen.has(id)) continue
        seen.add(id)
        const buffer = ref.readStream()
        let patched: Uint8Array | undefined
        try {
          patched = withEmptyNotdef(buffer.asUint8Array())
        } finally {
          buffer.destroy()
        }
        if (patched) {
          ref.writeStream(patched)
          changed++
        }
      }
    } catch {
      // A broken object is MuPDF's to report when the page draws, not
      // ours to fail the open over.
    }
  }
  return changed
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
