import * as mupdf from 'mupdf'

/**
 * Font bytes by FACE key, not by family. See `faceKey`.
 */
export type FontProvider = Map<string, Uint8Array>

/**
 * What distinguishes one face of a family from another.
 *
 * An OBJECT rather than positional flags, and taken as a whole: every
 * caller has an edit object with exactly these two properties on it, so it
 * passes the object itself and cannot get the argument order wrong.
 * `faceKey(family, false, true)` is a line nobody can read; two booleans
 * that mean opposite things when transposed is a bug waiting for the third
 * axis to be added.
 */
export type FaceStyle = { bold?: boolean; italic?: boolean }

/**
 * The key a family-and-style combination is stored and looked up under.
 *
 * Neither weight nor slope is a property of a font program -- Inter Bold
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
 * The suffixes append in a fixed order -- "Bold Italic", never "Italic
 * Bold" -- because the key IS the identity. Two spellings of one face would
 * embed the same font program twice under two resource names.
 */
export function faceKey(family: string, style?: FaceStyle): string {
  const suffix = `${style?.bold ? ' Bold' : ''}${style?.italic ? ' Italic' : ''}`
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
 * this -- one file per family per weight, not a variable font carrying the
 * whole axis: see apps/web/public/fonts/LICENSES.md.
 *
 * 'Latin' encoding means non-Latin scripts are out of scope this phase.
 * That is a known, stated limitation, not an oversight.
 *
 * Keyed by FACE, so a document with a bold heading over regular body copy
 * registers two font programs and two resource names. It has to: bold and
 * italic are separate files, not flags on this one.
 */
export class FontRegistry {
  #cache = new Map<string, { name: string; obj: mupdf.PDFObject }>()
  #raw: mupdf.PDFDocument
  #provider: FontProvider

  constructor(raw: mupdf.PDFDocument, provider: FontProvider) {
    this.#raw = raw
    this.#provider = provider
  }

  /** `face` is a `faceKey`, not a bare family. */
  resolve(face: string): { name: string; obj: mupdf.PDFObject } {
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
    const obj = this.#raw.addSimpleFont(font, 'Latin')
    const entry = { name: `F${this.#cache.size + 1}`, obj }
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
    for (const ch of text) total += font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0)!))
    return total * size
  }
}

/**
 * Escape a PDF literal string: backslash and both parentheses. An unescaped
 * `)` in user text would terminate the string early and corrupt every
 * operator after it in the content stream.
 */
export function pdfString(s: string): string {
  return `(${s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`
}
