import * as mupdf from 'mupdf'

export type FontProvider = Map<string, Uint8Array>

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
 * bundled faces are static weight-400 instances precisely because of this:
 * see apps/web/public/fonts/LICENSES.md.
 *
 * 'Latin' encoding means non-Latin scripts are out of scope this phase.
 * That is a known, stated limitation, not an oversight.
 */
export class FontRegistry {
  #cache = new Map<string, { name: string; obj: mupdf.PDFObject }>()
  #raw: mupdf.PDFDocument
  #provider: FontProvider

  constructor(raw: mupdf.PDFDocument, provider: FontProvider) {
    this.#raw = raw
    this.#provider = provider
  }

  resolve(family: string): { name: string; obj: mupdf.PDFObject } {
    const hit = this.#cache.get(family)
    if (hit) return hit
    const bytes = this.#provider.get(family)
    if (!bytes) {
      // Never substitute silently: text drawn in an unexpected face looks
      // subtly wrong and nobody notices until it is printed.
      throw new Error(
        `font "${family}" was not provided to the export. Load it before exporting.`,
      )
    }
    const font = new mupdf.Font(family, bytes)
    const obj = this.#raw.addSimpleFont(font, 'Latin')
    const entry = { name: `F${this.#cache.size + 1}`, obj }
    this.#cache.set(family, entry)
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
 */
export function createMeasurer(
  provider: FontProvider,
): (text: string, family: string, size: number) => number {
  const cache = new Map<string, mupdf.Font>()
  return (text, family, size) => {
    let font = cache.get(family)
    if (!font) {
      const bytes = provider.get(family)
      if (!bytes) {
        throw new Error(
          `font "${family}" was not provided to the export. Load it before exporting.`,
        )
      }
      font = new mupdf.Font(family, bytes)
      cache.set(family, font)
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
