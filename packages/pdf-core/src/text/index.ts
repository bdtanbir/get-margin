import type { PdfDocument } from '../engine.js'

/** 8 numbers: the four corners of one character's box, in MuPDF page space. */
export type Quad = [number, number, number, number, number, number, number, number]

export type CharQuad = { quad: Quad; char: string }

export type LineRun = {
  /** [x0, y0, x1, y1] in MuPDF page space. */
  bbox: [number, number, number, number]
  text: string
  font: string
  size: number
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
    let size = 0

    text.walk({
      beginLine(lineBox) {
        bbox = [lineBox[0], lineBox[1], lineBox[2], lineBox[3]]
        chars = []
        font = ''
        size = 0
      },
      onChar(c, _origin, charFont, charSize, quad) {
        // The run's font and size come from its first character. A line is
        // already a homogeneous style run in MuPDF's model, so later
        // characters agree; taking the first avoids an empty string on a
        // line that ends with whitespace carrying no font.
        if (!font) {
          font = charFont.getName()
          size = charSize
        }
        chars.push({ char: c, quad: [...quad] as Quad })
      },
      endLine() {
        // A line with no characters (an image-only block's stray line) is
        // not selectable text and would only add an empty hit target.
        if (bbox && chars.length > 0) {
          lines.push({ bbox, text: chars.map((c) => c.char).join(''), font, size, chars })
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
