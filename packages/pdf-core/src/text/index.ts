import { saneQuad } from './saneQuad.js'
import type { PdfDocument } from '../engine.js'
import type { Color } from '../write/types.js'
import { detectWeight, pageFontFacts } from './fontWeights.js'
import { hiddenIndices, invisibleCharTest } from './invisible.js'

/** 8 numbers: the four corners of one character's box, in MuPDF page space. */
export type Quad = [number, number, number, number, number, number, number, number]

export type CharQuad = { quad: Quad; char: string }

export type LineRun = {
  /** [x0, y0, x1, y1] in MuPDF page space. */
  bbox: [number, number, number, number]
  text: string
  /**
   * The font's PostScript name: what the embedded font program calls
   * itself when it says, otherwise the PDF's /BaseFont (subset tag and all).
   */
  font: string
  /**
   * The CSS weight the run is set in: 100 to 800, in hundreds.
   *
   * Carried because editing a line has to be able to redraw it at the
   * weight it was already in. Without this the patch editor had nothing to
   * inherit from and defaulted every replacement to regular, so retyping a
   * bold heading silently demoted it -- the one thing about the original
   * the user could see and the edit could not preserve. A boolean was the
   * first answer; a Medium heading came back as regular under it, which is
   * the same demotion one step lighter.
   *
   * Read from the embedded font program's own OS/2 weight class first,
   * then from the face's name, then from `isBold()`. See fontWeights.ts.
   */
  weight: number
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
  /**
   * The line as consecutive pieces of one style each, in order; their texts
   * joined are `text`. The fields above describe the FIRST piece.
   *
   * A MuPDF line is not one style: "This letter is to confirm that
   * **Arafat Hussain Chowdhury** (employee ID...)" is one line with a bold
   * name in the middle, and "14th" is one line with a smaller raised "th".
   * Reading the style off the first character alone is what made editing
   * such a line drop the bold. Pieces split where the weight, slope, size,
   * colour or baseline changes -- NOT where only the embedded subset
   * changes, because one face embedded as three subsets is still one face.
   */
  spans?: LineSpan[]
}

/** One single-style piece of a `LineRun`. */
export type LineSpan = {
  text: string
  font: string
  weight: number
  italic: boolean
  size: number
  color: Color
  /**
   * How far this piece's baseline sits ABOVE the line's, in points,
   * measured across the line's own direction. Positive for a superscript,
   * negative for a subscript, 0 for ordinary text.
   */
  rise: number
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
 * Names that mean italic even when the font's own flag does not say so.
 *
 * A supplement to `isItalic()`, not a substitute for it: a generator can
 * embed a subset of an oblique face and leave the fsSelection bit
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

/** The page-space box around every corner of every glyph. */
function unionOf(chars: CharQuad[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const c of chars) {
    for (let i = 0; i < 8; i += 2) {
      x0 = Math.min(x0, c.quad[i]!); x1 = Math.max(x1, c.quad[i]!)
      y0 = Math.min(y0, c.quad[i + 1]!); y1 = Math.max(y1, c.quad[i + 1]!)
    }
  }
  return [x0, y0, x1, y1]
}

export function buildQuadIndex(doc: PdfDocument, pageIndex: number): PageQuadIndex {
  // Validates the index and range before a page is ever loaded, matching
  // renderPage's discipline.
  doc.pageGeometry(pageIndex)

  const page = doc._raw().loadPage(pageIndex)
  try {
    const text = page.toStructuredText('')
    // Once per page, not per glyph: it decompresses every font program.
    const { weights: declaredWeights, names: programNames } = pageFontFacts(page)
    /**
     * The name a run's font goes by: what the embedded program calls
     * itself, else what the PDF calls it. See `sfntFontName` -- a /BaseFont
     * of `CIDFont+F4` is Times New Roman Bold underneath.
     */
    const nameOf = (font: { getName(): string }): string => {
      const reported = font.getName()
      return programNames.get(reported.replace(/^[A-Z]{6}\+/, '')) ?? reported
    }
    const lines: LineRun[] = []
    /** Every glyph on the current line, with the style piece it belongs to. */
    type Glyph = CharQuad & { origin: ArrayLike<number>; piece: Omit<LineSpan, 'text'> }
    let glyphs: Glyph[] = []
    let bbox: [number, number, number, number] | undefined
    let font = ''
    let weight = 400
    let italic = false
    let color: Color = [0, 0, 0]
    let size = 0
    let baseline = 0
    /** Whether any glyph on the line had a broken font's height capped. */
    let capped = false
    /** The line's "up", in page space (y grows down the page). */
    let up = { x: 0, y: -1 }
    let pen0: { x: number; y: number } | undefined
    /** Weight and slope per font: detectWeight reads the font's name and flags. */
    const faceOf = new Map<string, { weight: number; italic: boolean }>()
    /** Which U+FFFD characters draw nothing. See invisible.ts. */
    const invisible = invisibleCharTest(page)

    text.walk({
      beginLine(lineBox, _wmode, direction) {
        const dx = direction?.[0] ?? 1
        const dy = direction?.[1] ?? 0
        const len = Math.hypot(dx, dy) || 1
        up = { x: dy / len, y: -dx / len }
        pen0 = undefined
        bbox = [lineBox[0], lineBox[1], lineBox[2], lineBox[3]]
        glyphs = []
        font = ''
        weight = 400
        italic = false
        color = [0, 0, 0]
        size = 0
        baseline = 0
        capped = false
      },
      onChar(c, origin, charFont, charSize, quad, charColor) {
        // The run's font and size come from its first character. A line is
        // already a homogeneous style run in MuPDF's model, so later
        // characters agree; taking the first avoids an empty string on a
        // line that ends with whitespace carrying no font.
        if (!font) {
          font = nameOf(charFont)
          weight = detectWeight(charFont, declaredWeights)
          italic = isItalicFace(charFont)
          color = toRgb(charColor)
          size = charSize
          // The pen position, which IS the baseline. Taken from the first
          // character for the same reason as the font and size.
          baseline = origin[1] ?? 0
        }
        // Capped against the glyph's OWN size: a superscript on the line is
        // smaller than the line's first glyph, and its box should be too.
        const sane = saneQuad(quad, origin, charSize)
        if (sane.some((v, i) => v !== quad[i])) capped = true

        // Keyed by the PDF's own name, not the program's: two subsets can
        // share a family name and still be different weights.
        const reported = charFont.getName()
        let style = faceOf.get(reported)
        if (!style) {
          style = { weight: detectWeight(charFont, declaredWeights), italic: isItalicFace(charFont) }
          faceOf.set(reported, style)
        }
        const at = { x: origin[0] ?? 0, y: origin[1] ?? 0 }
        pen0 ??= at
        // Rounded so the sub-point jitter of a justified line does not
        // split every word into its own piece.
        const rise = Math.round(((at.x - pen0.x) * up.x + (at.y - pen0.y) * up.y) * 10) / 10
        glyphs.push({
          char: c,
          quad: sane as Quad,
          origin: [at.x, at.y],
          piece: {
            font: nameOf(charFont), weight: style.weight, italic: style.italic,
            size: charSize, color: toRgb(charColor), rise,
          },
        })
      },
      endLine() {
        // A line with no characters (an image-only block's stray line) is
        // not selectable text and would only add an empty hit target.
        if (bbox && glyphs.length > 0) {
          // MuPDF's own line box was built from the broken heights too, so
          // once a glyph was capped the box is rebuilt from the glyphs --
          // ALL of them, hidden ones included, so the box (and the cover an
          // edit draws over it) is the same with or without them.
          if (capped) bbox = unionOf(glyphs)
          // Glyphs that draw nothing and have no character are left out of
          // the line's TEXT only. See invisible.ts.
          const hidden = hiddenIndices(glyphs, invisible)
          const chars: CharQuad[] = []
          const spans: LineSpan[] = []
          glyphs.forEach((g, i) => {
            if (hidden.has(i)) return
            chars.push({ char: g.char, quad: g.quad })
            const p = g.piece
            const last = spans[spans.length - 1]
            if (
              last && last.weight === p.weight && last.italic === p.italic &&
              Math.abs(last.size - p.size) < 0.05 && last.rise === p.rise &&
              last.color.every((v, k) => Math.abs(v - p.color[k]!) < 0.004)
            ) {
              last.text += g.char
            } else {
              spans.push({ text: g.char, ...p })
            }
          })
          lines.push({
            bbox,
            text: chars.map((c) => c.char).join(''),
            font,
            weight,
            italic,
            color,
            size,
            baseline,
            chars,
            spans,
          })
        }
        bbox = undefined
        glyphs = []
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
