import type * as mupdf from 'mupdf'
import { BOLD_THRESHOLD, REGULAR_WEIGHT, WEIGHTS } from '../write/fonts.js'

/**
 * The weight a line of DOCUMENT text is set in, so that editing it can
 * redraw it at that weight rather than at regular or bold.
 *
 * Three sources, best first. The first is the face's NAME: a PostScript
 * name is "Family-Style", and the style word is what the type designer
 * called the weight. The second is the embedded font program's own OS/2
 * `usWeightClass`, for a name that says nothing -- a subset tagged
 * `ABCDEF+Calibri` has no style word, and the table is exact for it. The
 * third is `isBold()`, the one signal MuPDF reports, for a face with
 * neither.
 *
 * The name comes BEFORE the table, not after, because the table lies in
 * one well-known way: Inter's Thin and ExtraLight both declare 250, a
 * workaround for a Windows renderer that faux-bolded anything lighter,
 * and rounding that puts a Thin heading at 300. The name says Thin.
 */

/**
 * The weight a style word in a font's name means.
 *
 * Longer words first, so "ExtraBold" is not read as "Bold" and "SemiBold"
 * is not either. "Black" and "Heavy" are 900 here and clamped to 800 by
 * the caller, because the weight table is what the name MEANS and the
 * clamp is what the app can DRAW; keeping them apart is what lets a future
 * 900 file need one change rather than two.
 *
 * "Regular", "Book", "Normal" and "Roman" all mean 400 and are listed so a
 * face named "Foo-Roman" resolves here rather than falling through to
 * `isBold()`, which agrees anyway; the list is for the reader.
 */
const NAME_WEIGHTS: ReadonlyArray<readonly [RegExp, number]> = [
  [/extra[ -]?light|ultra[ -]?light/i, 200],
  [/extra[ -]?bold|ultra[ -]?bold|-xb\b/i, 800],
  [/semi[ -]?bold|demi[ -]?bold|-sb\b/i, 600],
  [/hairline|thin/i, 100],
  [/light/i, 300],
  [/medium/i, 500],
  [/black|heavy/i, 900],
  [/bold|-bd\b/i, 700],
  [/regular|book|normal|roman/i, 400],
]

/**
 * The weight a font's NAME claims, if it claims one.
 *
 * Only the STYLE part is read -- what follows the last `-` or `,`, which
 * is where a PostScript name (`Inter-Bold`) and a Windows one
 * (`Arial,BoldItalic`) both keep it. Reading the whole name would take a
 * family called "LightSans" for a Light.
 */
export function weightFromName(name: string): number | undefined {
  const style = name.replace(/^[A-Z]{6}\+/, '').split(/[-,]/).pop() ?? name
  for (const [pattern, weight] of NAME_WEIGHTS) {
    if (pattern.test(style)) return weight
  }
  return undefined
}

/**
 * `usWeightClass` from an sfnt's OS/2 table, or nothing.
 *
 * Written by hand rather than pulled from a parser because it answers one
 * question. The layout is fixed by the OpenType spec: a 12-byte header, then
 * 16-byte table records, and `usWeightClass` at offset 4 of the OS/2 table.
 * Accepts TrueType (0x00010000 or 'true') and OpenType CFF ('OTTO') alike,
 * which is why it takes bytes and not a file kind: /FontFile2 and an
 * OpenType /FontFile3 both land here.
 *
 * Returns nothing rather than throwing for anything it cannot read. The
 * caller has two more sources to fall back on, and a font program a
 * generator mangled is a reason to read the name, not to lose the line.
 */
export function usWeightClass(bytes: Uint8Array): number | undefined {
  if (bytes.byteLength < 12) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = view.getUint32(0)
  if (magic !== 0x00010000 && magic !== 0x4f54544f && magic !== 0x74727565) return undefined
  const numTables = view.getUint16(4)
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16
    if (record + 16 > bytes.byteLength) return undefined
    const tag = String.fromCharCode(...bytes.subarray(record, record + 4))
    if (tag !== 'OS/2') continue
    const at = view.getUint32(record + 8)
    if (at + 6 > bytes.byteLength) return undefined
    const weight = view.getUint16(at + 4)
    return weight > 0 ? weight : undefined
  }
  return undefined
}

/**
 * A font resource's name as MuPDF will report it for the glyphs drawn in
 * it: the /BaseFont with any subset tag (`ABCDEF+`) removed.
 */
function baseName(font: mupdf.PDFObject): string | undefined {
  const base = font.get('BaseFont')
  if (!base.isName()) return undefined
  return base.asName().replace(/^[A-Z]{6}\+/, '')
}

/** The descriptor a font resource's weight lives in, following a Type0 down to its CID font. */
function descriptorOf(font: mupdf.PDFObject): mupdf.PDFObject | undefined {
  let direct = font.get('FontDescriptor')
  if (direct.isDictionary()) return direct
  const descendants = font.get('DescendantFonts')
  if (descendants.isArray() && descendants.length > 0) {
    direct = descendants.get(0).get('FontDescriptor')
    if (direct.isDictionary()) return direct
  }
  return undefined
}

/** The weight a descriptor declares: its embedded program's, else its own /FontWeight. */
function descriptorWeight(descriptor: mupdf.PDFObject): number | undefined {
  for (const key of ['FontFile2', 'FontFile3']) {
    const file = descriptor.get(key)
    if (!file.isStream()) continue
    try {
      // Read and released at once: the buffer is a copy of a whole font
      // program in WASM memory, and a page has a handful of them.
      const buffer = file.readStream()
      try {
        const weight = usWeightClass(buffer.asUint8Array())
        if (weight !== undefined) return weight
      } finally {
        buffer.destroy()
      }
    } catch {
      // A stream MuPDF cannot decode is not a reason to lose the line; the
      // name and the flag are still there to read.
    }
  }
  const declared = descriptor.get('FontWeight')
  if (declared.isNumber()) {
    const weight = declared.asNumber()
    if (weight > 0) return weight
  }
  return undefined
}

/**
 * The declared weight of every font in a page's resources, by the name
 * MuPDF reports glyphs drawn in it under.
 *
 * Walked ONCE per page rather than per glyph: reading a font program out of
 * its stream is a decompression, and a page has thousands of glyphs and a
 * handful of fonts. Fonts inside form XObjects are not walked; a run drawn
 * in one falls through to the name and the flag.
 */
export function pageFontWeights(page: mupdf.PDFPage): Map<string, number> {
  const weights = new Map<string, number>()
  try {
    const fonts = page.getObject().get('Resources').get('Font')
    if (!fonts.isDictionary()) return weights
    fonts.forEach((font) => {
      const resolved = font.resolve()
      if (!resolved.isDictionary()) return
      const name = baseName(resolved)
      if (!name || weights.has(name)) return
      const descriptor = descriptorOf(resolved)
      const weight = descriptor ? descriptorWeight(descriptor) : undefined
      if (weight !== undefined) weights.set(name, weight)
    })
  } catch {
    // A page whose resources will not resolve is a page whose lines still
    // have names and flags to read.
  }
  return weights
}

/** `weight` rounded to the nearest hundred and held within what can be drawn. */
export function clampWeight(weight: number): number {
  const first = WEIGHTS[0]
  const last = WEIGHTS[WEIGHTS.length - 1]!
  return Math.min(last, Math.max(first, Math.round(weight / 100) * 100))
}

/**
 * The weight a run of glyphs is drawn in, from the sources above in order.
 *
 * `declared` is what `pageFontWeights` found for this page, keyed by the
 * name MuPDF reports; the subset tag is stripped on both sides so the two
 * agree whichever one kept it.
 */
export function detectWeight(
  font: { isBold(): boolean; getName(): string },
  declared: ReadonlyMap<string, number>,
): number {
  const name = font.getName()
  const weight =
    weightFromName(name)
    ?? declared.get(name) ?? declared.get(name.replace(/^[A-Z]{6}\+/, ''))
    ?? (font.isBold() ? 700 : REGULAR_WEIGHT)
  return clampWeight(weight)
}

/** Whether a weight reads as bold on the page. */
export function isBoldWeight(weight: number): boolean {
  return weight >= BOLD_THRESHOLD
}
