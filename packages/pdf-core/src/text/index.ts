import type { PdfDocument } from '../engine.js'
import type { Color } from '../write/types.js'

/** 8 numbers: the four corners of one character's box, in MuPDF page space. */
export type Quad = [number, number, number, number, number, number, number, number]

export type CharQuad = { quad: Quad; char: string }

export type LineRun = {
  /** [x0, y0, x1, y1] in MuPDF page space. */
  bbox: [number, number, number, number]
  text: string
  font: string
  /**
   * Whether the run is set in a BOLD face.
   *
   * Carried because editing a line has to be able to redraw it at the
   * weight it was already in. Without this the patch editor had nothing to
   * inherit from and defaulted every replacement to regular, so retyping a
   * bold heading silently demoted it -- the one thing about the original
   * the user could see and the edit could not preserve.
   *
   * `isBold()` is the authority and it is reliable for both the standard 14
   * (`Helvetica-Bold` -> true) and embedded TrueType subsets, which is the
   * real-world case. The name check behind it is for generators that embed
   * a bold face without setting the OS/2 macStyle bit -- the flag is then
   * false and the name is the only remaining evidence.
   *
   * Note that `isSerif()` is NOT carried, deliberately: it returns true for
   * every embedded TTF this was tested against, Inter included, so it would
   * be a coin flip dressed up as a fact.
   */
  bold: boolean
  /**
   * Whether the run is set on a SLANT.
   *
   * `isItalic()` is trustworthy where `isSerif()` is not -- checked against
   * embedded TrueType, not only the standard 14, and it reports bold and
   * italic together correctly for a bold-italic face. It is also right
   * where the font file's own `post.italicAngle` is not: Roboto's italic
   * declares an angle of 0 and is unmistakably slanted, so the angle is not
   * a signal worth consulting and the flag is.
   */
  italic: boolean
  /**
   * The colour the run is FILLED with, sRGB 0..1 -- the same range and the
   * same type every object in the format stores.
   *
   * MuPDF hands this to `onChar` already converted to three components
   * whatever the page's own colour space was: a grey fill and a CMYK fill
   * both arrive as RGB, verified against a fixture drawn in all three.
   *
   * Carried because editing a line used to hardcode black, so replacing a
   * word in a grey label turned it black -- the edit announced itself by
   * being the only thing on the row in the wrong colour.
   */
  color: Color
  size: number
  /**
   * The line's baseline in page space -- where the glyphs actually sit.
   *
   * Not derivable from `bbox`. The box is the glyph extent, and how far the
   * baseline sits above its bottom depends on the font's descender, which
   * varies. Anything redrawing over this line has to be told, or it guesses
   * -- and a guess puts replacement text at a different height from the
   * text it replaced, which is visible the moment they sit side by side.
   */
  baseline: number
  chars: CharQuad[]
}

export type PageQuadIndex = { lines: LineRun[] }

/**
 * A geometric index of every character on a page, for text selection.
 *
 * COORDINATE SPACE: MuPDF PAGE SPACE -- top-down, CropBox origin normalised,
 * /Rotate applied. The same space toPixmap, getBounds, and the annotation
 * setters use. This deliberately does NOT convert to raw bottom-up PDF user
 * space: markup annotations (Task 38) consume these quads directly through
 * setQuadPoints, which expects exactly this space, so converting here and
 * back there would be a round trip through the wrong space.
 *
 * BUILT FROM ONE CALL, NOT TWO. The plan specified asJSON() for line runs
 * plus walk({onChar}) for per-character quads, matching each character to
 * the line whose bbox contains it. That matching is unnecessary: walk's
 * beginLine/endLine already bracket a line's characters, and onChar carries
 * the font and size too (mupdf.d.ts:251-253, verified against this
 * fixture). Grouping by callback order is exact, where matching by bbox
 * containment is a heuristic that mis-assigns characters wherever two lines'
 * boxes overlap -- superscripts, tight leading, and rotated runs.
 */
/**
 * Names that mean bold even when the font's own weight flag does not say so.
 *
 * Not a substitute for `isBold()` -- a supplement to it. Some generators
 * embed a subset of a bold face and leave the OS/2 macStyle bit clear, and
 * for those the PostScript name is the only thing left that knows. Kept
 * narrow on purpose: "Semibold" and "Demibold" are here because they read
 * as bold on the page, while "Medium" is not, because it does not.
 */
const BOLD_IN_NAME = /bold|black|heavy|semibold|demibold|-bd\b/i

function isBoldFace(font: { isBold(): boolean; getName(): string }): boolean {
  return font.isBold() || BOLD_IN_NAME.test(font.getName())
}

/**
 * Names that mean italic even when the font's own flag does not say so.
 *
 * The same supplement `BOLD_IN_NAME` is, for the same reason: a generator
 * can embed a subset of an oblique face and leave the fsSelection bit
 * clear, and then the PostScript name is all that is left. "Oblique" counts
 * because it is what the standard 14 call theirs.
 */
const ITALIC_IN_NAME = /italic|oblique|-it\b/i

function isItalicFace(font: { isItalic(): boolean; getName(): string }): boolean {
  return font.isItalic() || ITALIC_IN_NAME.test(font.getName())
}

/**
 * A glyph's fill colour as an sRGB triple.
 *
 * MuPDF converts to three components before it gets here -- grey and CMYK
 * fills both arrive as RGB, which a fixture drawn in all three confirms --
 * so the guard is for the case where a future version does not, and black
 * is the only honest answer to a colour this cannot read. Guessing from a
 * one- or four-component array would be inventing a colour and presenting
 * it as the document's.
 */
function toRgb(color: readonly number[] | undefined): Color {
  if (!color || color.length !== 3) return [0, 0, 0]
  return [color[0]!, color[1]!, color[2]!]
}

export function buildQuadIndex(doc: PdfDocument, pageIndex: number): PageQuadIndex {
  // Validates the index and range before a page is ever loaded, matching
  // renderPage's discipline.
  doc.pageGeometry(pageIndex)

  const page = doc._raw().loadPage(pageIndex)
  try {
    const text = page.toStructuredText('')
    const lines: LineRun[] = []
    let chars: CharQuad[] = []
    let bbox: [number, number, number, number] | undefined
    let font = ''
    let bold = false
    let italic = false
    let color: Color = [0, 0, 0]
    let size = 0
    let baseline = 0

    text.walk({
      beginLine(lineBox) {
        bbox = [lineBox[0], lineBox[1], lineBox[2], lineBox[3]]
        chars = []
        font = ''
        bold = false
        italic = false
        color = [0, 0, 0]
        size = 0
        baseline = 0
      },
      onChar(c, origin, charFont, charSize, quad, charColor) {
        // The run's font and size come from its first character. A line is
        // already a homogeneous style run in MuPDF's model, so later
        // characters agree; taking the first avoids an empty string on a
        // line that ends with whitespace carrying no font.
        if (!font) {
          font = charFont.getName()
          bold = isBoldFace(charFont)
          italic = isItalicFace(charFont)
          color = toRgb(charColor)
          size = charSize
          // The pen position, which IS the baseline. Taken from the first
          // character for the same reason as the font and size.
          baseline = origin[1] ?? 0
        }
        chars.push({ char: c, quad: [...quad] as Quad })
      },
      endLine() {
        // A line with no characters (an image-only block's stray line) is
        // not selectable text and would only add an empty hit target.
        if (bbox && chars.length > 0) {
          lines.push({
            bbox,
            text: chars.map((c) => c.char).join(''),
            font,
            bold,
            italic,
            color,
            size,
            baseline,
            chars,
          })
        }
        bbox = undefined
        chars = []
      },
    })

    return { lines }
  } finally {
    // Disposal is a correctness requirement, not hygiene: a leaked page does
    // not degrade gradually, it hard-crashes the WASM heap several hundred
    // pages into a sweep (docs/findings/00-engine-facts.md).
    page.destroy()
  }
}
