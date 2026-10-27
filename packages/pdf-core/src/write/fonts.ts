import * as mupdf from 'mupdf'

/**
 * Font bytes by FACE key, not by family. See `faceKey`.
 */
export type FontProvider = Map<string, Uint8Array>

/**
 * The weights a face can be set in: CSS weights 100 (Thin) to 800 (Extra
 * Bold), in steps of a hundred.
 *
 * 900 is deliberately absent. It is what "Black" faces declare, and no
 * family bundled has a file for it, so a document line detected at 900
 * edits at 800 -- the nearest weight that exists -- rather than at a value
 * the writer could only refuse.
 */
export const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800] as const
export type Weight = (typeof WEIGHTS)[number]

/** The weight an object with no `weight` set is drawn in. */
export const REGULAR_WEIGHT: Weight = 400

/** The weight from which a face reads as bold on the page. */
export const BOLD_THRESHOLD = 600

/**
 * What distinguishes one face of a family from another.
 *
 * An OBJECT rather than positional arguments, and taken as a whole: every
 * caller has an edit object with exactly these two properties on it, so it
 * passes the object itself and cannot get the argument order wrong.
 * `faceKey(family, 700, true)` is a line nobody can read.
 *
 * `weight` is optional and absent means 400 -- which is what every object
 * stored before weight existed was drawn in.
 */
export type FaceStyle = { weight?: number; italic?: boolean }

/** The weight a style is set in, with the format's default applied. */
export function weightOf(style?: FaceStyle): number {
  return style?.weight ?? REGULAR_WEIGHT
}

/**
 * The nearest of `available` to `weight`, or the nearest bundled weight
 * when no list is given.
 *
 * Ties go DOWN: a detected 650 -- possible, `usWeightClass` is any number
 * -- becomes 600 rather than 700, because the lighter reading is the one
 * that changes the least on a page whose text was not actually bold.
 */
export function nearestWeight(weight: number, available: readonly number[] = WEIGHTS): number {
  let best = available[0] ?? REGULAR_WEIGHT
  for (const w of available) {
    if (Math.abs(w - weight) < Math.abs(best - weight)) best = w
  }
  return best
}

/**
 * The key a family-and-style combination is stored and looked up under.
 *
 * Neither weight nor slope is a property of a font program -- Inter 500
 * Italic is a different FILE from Inter, with its own outlines and its own
 * advance widths -- so everything downstream of this point (the provider
 * map, the registry cache, the measurer's cache, the /Font resource) has to
 * address a FACE rather than a family. One function so the writer and the
 * browser cannot disagree about what that address is;
 * `apps/web/src/lib/fonts.ts` maps the same keys onto files.
 *
 * Deliberately a string rather than a tuple: the three caches below are all
 * `Map<string, _>` keyed by exactly this, and a tuple key would need a
 * comparator in each of them.
 *
 * Weight 400 is left off, so the regular is addressed by its bare family
 * name -- `Inter`, not `Inter 400` -- and the suffixes append in a fixed
 * order, "500 Italic" and never "Italic 500", because the key IS the
 * identity. Two spellings of one face would embed the same font program
 * twice under two resource names.
 */
export function faceKey(family: string, style?: FaceStyle): string {
  const weight = weightOf(style)
  const suffix =
    `${weight === REGULAR_WEIGHT ? '' : ` ${weight}`}${style?.italic ? ' Italic' : ''}`
  return `${family}${suffix}`
}

/**
 * Register a font once per document and return the resource name to use.
 *
 * NO SUBSETTING. Phase 0 measured that addSimpleFont embeds the entire font
 * program, Flate-compressed only, at 57-65% of raw bytes, and that
 * doc.subsetFonts() makes zero difference for a freshly registered font.
 * Subsetting via pdf-lib + @pdf-lib/fontkit is deliberately deferred to
 * Phase 4 (PHASE-2-DESIGN.md section 0) -- it is a size optimisation, not a
 * capability, and keeping a second PDF library out of the export path while
 * that path is still being proven is worth roughly 180KB per document. The
 * bundled faces are static single-weight instances precisely because of
 * this -- one file per family per weight per slope, not a variable font
 * carrying the whole axis: see apps/web/public/fonts/LICENSES.md.
 *
 * Embedded as a Type0 font with Identity-H encoding, so text is written as
 * two-byte GLYPH numbers with a ToUnicode map beside them. It used to be a
 * one-byte WinAnsi font, which can hold about 220 characters: anything else
 * -- Cyrillic, Greek, most of Latin Extended -- could not be written at all,
 * and the content stream's UTF-8 turned every accent, curly quote and dash
 * into two wrong letters ("Ì" became "ÃŒ"). Now every character the font
 * itself has is written exactly, and copies back out as itself.
 *
 * Keyed by FACE, so a document with a bold heading over regular body copy
 * registers two font programs and two resource names. It has to: every
 * weight and every slope is a separate file, not a flag on this one.
 */
export class FontRegistry {
  #cache = new Map<string, { name: string; obj: mupdf.PDFObject; font: mupdf.Font }>()
  #raw: mupdf.PDFDocument
  #provider: FontProvider

  constructor(raw: mupdf.PDFDocument, provider: FontProvider) {
    this.#raw = raw
    this.#provider = provider
  }

  /** `face` is a `faceKey`, not a bare family. */
  resolve(face: string): { name: string; obj: mupdf.PDFObject; font: mupdf.Font } {
    const hit = this.#cache.get(face)
    if (hit) return hit
    const bytes = this.#provider.get(face)
    if (!bytes) {
      // Never substitute silently: text drawn in an unexpected face looks
      // subtly wrong and nobody notices until it is printed. That covers
      // weight and slope too -- falling back to the regular when the bold
      // italic was not supplied would export a heading that is not the
      // heading the user laid out, and nothing would report it.
      throw new Error(
        `font "${face}" was not provided to the export. Load it before exporting.`,
      )
    }
    const font = new mupdf.Font(face, bytes)
    const obj = this.#raw.addFont(font)
    const entry = { name: `F${this.#cache.size + 1}`, obj, font }
    this.#cache.set(face, entry)
    return entry
  }
}

/**
 * Text measurement from MuPDF's own glyph advances.
 *
 * Phase 0 verified `font.advanceGlyph(font.encodeCharacter(ch)) * size`
 * matches `showString`'s advance to 5 decimal places, which is what lets the
 * writer's alignment maths agree with what the viewer will actually draw.
 * The Font objects are cached per call to replay(): constructing one parses
 * the whole font program.
 *
 * Measured per FACE. Bold glyphs are wider -- measurably so, "Hello margin"
 * is 6.16 em in Inter Bold against 5.95 in Inter -- and an italic's are
 * narrower again, so measuring one face against another would put every
 * centred and right-aligned line slightly off, in the exported file, with
 * nothing to show it had happened.
 */
export function createMeasurer(
  provider: FontProvider,
): (text: string, face: string, size: number) => number {
  const cache = new Map<string, mupdf.Font>()
  return (text, face, size) => {
    let font = cache.get(face)
    if (!font) {
      const bytes = provider.get(face)
      if (!bytes) {
        throw new Error(
          `font "${face}" was not provided to the export. Load it before exporting.`,
        )
      }
      font = new mupdf.Font(face, bytes)
      cache.set(face, font)
    }
    let total = 0
    // Iterating the string (not indexing it) walks CODE POINTS, so a
    // character outside the BMP is measured once rather than as two halves
    // of a surrogate pair.
    // A character the font has no glyph for is not drawn (see `pdfText`),
    // so it takes no room either.
    for (const ch of text) {
      const gid = font.encodeCharacter(ch.codePointAt(0)!)
      if (gid !== 0) total += font.advanceGlyph(gid)
    }
    return total * size
  }
}

/**
 * The width a line takes up: its glyph advances plus the letter spacing
 * between each pair of characters.
 *
 * BETWEEN, not after: the content stream's `Tc` operator adds the spacing
 * after every glyph including the last, but the last one moves only the
 * pen and draws nothing, so the ink ends a gap short of where the pen
 * does. Alignment and fit are about the ink. The preview measures the
 * same way (`spacedWidth` in apps/web/src/lib/fonts.ts), which is what
 * keeps a centred spaced line centred after export.
 *
 * Counted in code points, like `createMeasurer`, so a character outside
 * the BMP is one gap and not two.
 */
export function spacedAdvance(
  measure: (text: string, face: string, size: number) => number,
  text: string,
  face: string,
  size: number,
  spacing: number | undefined,
): number {
  const gaps = Math.max(0, [...text].length - 1)
  return measure(text, face, size) + (spacing ?? 0) * gaps
}

/**
 * The 32 WinAnsi codes in 0x80..0x9F that are not Latin-1, by character.
 * Everything else WinAnsi holds is printable ASCII or 0xA0..0xFF, which are
 * the same numbers as their Unicode code points.
 */
const WIN_ANSI_HIGH: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
])

/**
 * A character's byte in WinAnsiEncoding -- the encoding every font the
 * export embeds is given (`addSimpleFont(font, 'Latin')`) -- or nothing
 * when WinAnsi has no code for it.
 */
export function winAnsiByte(ch: string): number | undefined {
  const cp = ch.codePointAt(0)!
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp
  return WIN_ANSI_HIGH.get(cp)
}

/**
 * A PDF literal string holding `s` as WinAnsi bytes, written in plain ASCII.
 *
 * The content stream is handed to MuPDF as a JavaScript string, which it
 * stores as UTF-8 -- so writing "Ì" or "’" into it as-is put TWO bytes in
 * the stream, and the WinAnsi font drew each one: an edited "Ì" came out as
 * "ÃŒ", "children’s" as "childrenâ€™s". Each byte outside printable ASCII is
 * written as an octal escape instead, so the stream carries exactly the
 * byte the font is meant to read.
 *
 * Backslash and both parentheses are escaped too: an unescaped `)` in user
 * text would end the string early and corrupt every operator after it.
 *
 * A character WinAnsi cannot hold is left out -- it would otherwise be drawn
 * as some other character. The editor warns about it before export (see
 * `missingGlyphs`), and the measurer skips it, so alignment matches the ink.
 */
export function pdfString(s: string): string {
  let out = '('
  for (const ch of s) {
    const byte = winAnsiByte(ch)
    if (byte === undefined) continue
    if (ch === '\\' || ch === '(' || ch === ')') out += `\\${ch}`
    else if (byte >= 0x20 && byte <= 0x7e) out += ch
    else out += `\\${byte.toString(8).padStart(3, '0')}`
  }
  return `${out})`
}

/**
 * Text as a hex string of glyph numbers, for a font registered by
 * `FontRegistry` (Type0, Identity-H): two bytes per glyph.
 *
 * A character the font has no glyph for is left out rather than drawn as
 * the font's "missing glyph" box. The editor warns about those before
 * export (see `missingGlyphs`), and the measurer skips them too, so the
 * alignment matches the ink.
 */
export function pdfText(font: mupdf.Font, s: string): string {
  let hex = ''
  for (const ch of s) {
    const gid = font.encodeCharacter(ch.codePointAt(0)!)
    if (gid === 0) continue
    hex += gid.toString(16).padStart(4, '0')
  }
  return `<${hex}>`
}
