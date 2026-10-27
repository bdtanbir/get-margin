import * as mupdf from 'mupdf'
import { saneQuad } from './saneQuad.js'

/**
 * A line of the page's own text, as the export reads it.
 *
 * The same walk `buildQuadIndex` does, kept to what the writers need: so
 * the line numbers agree with the editor's, each line starts on
 * `beginLine` whether or not a character follows.
 */
export type PageLine = {
  text: string
  /** Union of the characters' (capped) boxes, in MuPDF page space. */
  bbox: [number, number, number, number]
  /** The size the line was set in, from its first glyph. */
  size: number
  /** The pen at the start of the line, in page space. */
  origin: { x: number; y: number } | null
  /** Which way the line runs, in page space. */
  dir: { x: number; y: number }
  /** Each character: its pen position and its (capped) box. */
  glyphs: Array<{ char: string; origin: number[]; quad: number[] }>
}

export function readLines(page: mupdf.Page): PageLine[] {
  const lines: PageLine[] = []
  const structured = page.toStructuredText('')
  try {
    structured.walk({
      beginLine: (_bbox: unknown, _wmode: number, direction: number[]) => {
        lines.push({
          text: '',
          bbox: [Infinity, Infinity, -Infinity, -Infinity],
          size: 0,
          origin: null,
          glyphs: [],
          // A walker that predates the argument, or a degenerate run, reads
          // as ordinary left-to-right rather than as a zero-length direction.
          dir: { x: direction?.[0] ?? 1, y: direction?.[1] ?? 0 },
        })
      },
      onChar: (c: string, origin: number[], _font: unknown, size: number, quad: number[]) => {
        const line = lines[lines.length - 1]
        if (!line) return
        // First glyph decides: a line is a homogeneous style run in MuPDF's
        // model, and the pen position at its start is the line's baseline.
        if (line.text === '') {
          line.size = size
          line.origin = { x: origin[0] ?? 0, y: origin[1] ?? 0 }
        }
        line.text += c
        // Capped exactly as buildQuadIndex caps it, so the box exported is
        // the box the user saw. See saneQuad.ts.
        const sane = saneQuad(quad, origin, size)
        line.glyphs.push({ char: c, origin: [origin[0] ?? 0, origin[1] ?? 0], quad: sane })
        for (let i = 0; i < 8; i += 2) {
          line.bbox[0] = Math.min(line.bbox[0], sane[i]!)
          line.bbox[2] = Math.max(line.bbox[2], sane[i]!)
          line.bbox[1] = Math.min(line.bbox[1], sane[i + 1]!)
          line.bbox[3] = Math.max(line.bbox[3], sane[i + 1]!)
        }
      },
    } as never)
  } finally {
    structured.destroy()
  }
  return lines
}

/** The centre of a glyph's box. */
function centreOf(quad: number[]): [number, number] {
  let x = 0, y = 0
  for (let i = 0; i < 8; i += 2) { x += quad[i]!; y += quad[i + 1]! }
  return [x / 4, y / 4]
}

/** The axis-aligned box around a quad. */
function boxOf(quad: number[]): [number, number, number, number] {
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!]
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!]
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/** Half the side of the square aimed at each glyph's centre. */
const AIM = 0.5

/**
 * Take lines of text off the page -- the text only, nothing drawn around
 * or under it -- and say which of them were taken.
 *
 * WHY. Editing a line used to paint an opaque box over it and write the new
 * text on top. Wherever the line sat close to something else, the box hid
 * that too: a Turnitin heading sits on the bottom edge of the page's logo,
 * and every edit of it cut the logo and the running header in half.
 * Removing the glyphs themselves touches nothing else.
 *
 * HOW. MuPDF's redaction, told to leave images and line art alone and take
 * text only, aimed at each character by a tiny square at the centre of its
 * box rather than one rectangle over the line -- so a neighbour is only
 * caught if its own glyphs sit on those very points.
 *
 * A line is LEFT IN PLACE (and the caller covers it the old way) when:
 * - one of its glyph centres falls inside another line's glyph box, so
 *   removing it could take part of the neighbour too -- lines set tighter
 *   than they are tall;
 * - any of its characters is invisible text (render mode 3). That is an
 *   OCR layer over a scanned image: the letters a reader sees are pixels,
 *   and removing the invisible copy would leave them showing under the
 *   replacement.
 *
 * Redaction also deletes link annotations it overlaps -- an edit is not
 * meant to unlink a URL -- so any annotation the page lost is put back.
 */
export function removeLines(page: mupdf.PDFPage, lines: PageLine[], targets: Iterable<number>): Set<number> {
  const wanted = new Set([...targets].filter((i) => (lines[i]?.glyphs.length ?? 0) > 0))
  if (wanted.size === 0) return new Set()

  // One pass over the page for two things: every INVISIBLE glyph's pen
  // position, and the real drawn box of every glyph that sits at one of the
  // target lines' pen positions. The second is what the redaction actually
  // tests against, and for some glyphs it is nowhere near the character's
  // text box: an empty glyph bounds to a point on the baseline, and a
  // "missing glyph" box drawn with no advance sits to the right of its pen.
  // Aiming only at text-box centres left exactly those behind.
  const targetsAt: Array<{ line: number; x: number; y: number }> = []
  for (const i of wanted) for (const g of lines[i]!.glyphs) targetsAt.push({ line: i, x: g.origin[0]!, y: g.origin[1]! })
  const extraAims = new Map<number, Array<[number, number]>>()
  const invisible: Array<[number, number]> = []
  const near = (ax: number, ay: number, bx: number, by: number): boolean =>
    Math.abs(ax - bx) < 0.05 && Math.abs(ay - by) < 0.05

  const visit = (visible: boolean) => (text: mupdf.Text, ctm: mupdf.Matrix): void => {
    text.walk({
      showGlyph(font, trm, gid, unicode) {
        const at = mupdf.Matrix.concat(trm, ctm)
        const x = at[4]!, y = at[5]!
        if (!visible) invisible.push([x, y])
        const target = targetsAt.find((t) => near(t.x, t.y, x, y))
        if (!target) return
        const one = new mupdf.Text()
        try {
          one.showGlyph(font, trm, gid, unicode)
          const [x0, y0, x1, y1] = one.getBounds(null as never, ctm)
          const list = extraAims.get(target.line) ?? []
          list.push([(x0! + x1!) / 2, (y0! + y1!) / 2])
          extraAims.set(target.line, list)
        } finally {
          one.destroy()
        }
      },
    })
  }
  const device = new mupdf.Device({
    fillText: visit(true),
    strokeText: (text, _stroke, ctm) => visit(true)(text, ctm),
    ignoreText: visit(false),
  })
  try {
    page.run(device, mupdf.Matrix.identity)
    device.close()
  } finally {
    device.destroy()
  }

  /**
   * Where to aim for line `i`: each character's box centre, each drawn
   * glyph's, and -- for a glyph with no width -- a little way along the line
   * from its pen. MuPDF's redaction gives such a glyph a small box running
   * FORWARD from the pen, measured: a square on the pen leaves it, one a
   * tenth of the size ahead takes it. Without this, the empty glyphs at the
   * end of the Turnitin heading survived as a stray "\ufffd" line.
   */
  const aimsFor = (i: number): Array<[number, number]> => {
    const line = lines[i]!
    const aims: Array<[number, number]> = []
    const len = Math.hypot(line.dir.x, line.dir.y) || 1
    const ux = line.dir.x / len, uy = line.dir.y / len
    const ahead = Math.max(0.5, line.size * 0.1)
    for (const g of line.glyphs) {
      const [cx, cy] = centreOf(g.quad)
      aims.push([cx, cy])
      const [x0, y0, x1, y1] = boxOf(g.quad)
      const width = Math.abs((x1 - x0) * ux) + Math.abs((y1 - y0) * uy)
      if (width < Math.max(0.05, line.size * 0.02)) aims.push([cx + ux * ahead, cy + uy * ahead])
    }
    return [...aims, ...(extraAims.get(i) ?? [])]
  }

  const others: Array<[number, number, number, number]> = []
  lines.forEach((line, i) => {
    if (!wanted.has(i)) for (const g of line.glyphs) others.push(boxOf(g.quad))
  })

  const removable = new Set<number>()
  for (const i of wanted) {
    const line = lines[i]!
    const clear = aimsFor(i).every(([cx, cy]) => !others.some(([x0, y0, x1, y1]) =>
      cx + AIM > x0 && cx - AIM < x1 && cy + AIM > y0 && cy - AIM < y1))
    const shown = line.glyphs.every((g) => !invisible.some(([x, y]) => near(x, y, g.origin[0]!, g.origin[1]!)))
    if (clear && shown) removable.add(i)
  }
  if (removable.size === 0) return removable

  const pageObj = page.getObject()
  const annotsBefore: mupdf.PDFObject[] = []
  const list = pageObj.get('Annots')
  if (list.isArray()) for (let i = 0; i < list.length; i++) annotsBefore.push(list.get(i))

  try {
    for (const i of removable) {
      for (const [cx, cy] of aimsFor(i)) {
        page.createAnnotation('Redact').setRect([cx - AIM, cy - AIM, cx + AIM, cy + AIM])
      }
    }
    page.applyRedactions(
      false,
      mupdf.PDFPage.REDACT_IMAGE_NONE,
      mupdf.PDFPage.REDACT_LINE_ART_NONE,
      mupdf.PDFPage.REDACT_TEXT_REMOVE,
    )
  } catch {
    // Nothing was taken, or not reliably: every line goes back to being
    // covered, and the half-made redaction marks are cleared away.
    clearRedactMarks(pageObj)
    return new Set()
  }

  // Put back what the redaction took that was not text.
  const now = pageObj.get('Annots')
  const present = new Set<number>()
  if (now.isArray()) for (let i = 0; i < now.length; i++) if (now.get(i).isIndirect()) present.add(now.get(i).asIndirect())
  for (const annot of annotsBefore) {
    if (!annot.isIndirect() || present.has(annot.asIndirect())) continue
    if (!pageObj.get('Annots').isArray()) pageObj.put('Annots', [])
    pageObj.get('Annots').push(annot)
  }
  return removable
}

/** Drop any Redact annotation left on the page. */
function clearRedactMarks(pageObj: mupdf.PDFObject): void {
  const list = pageObj.get('Annots')
  if (!list.isArray()) return
  for (let i = list.length - 1; i >= 0; i--) {
    const subtype = list.get(i).get('Subtype')
    if (subtype.isName() && subtype.asName() === 'Redact') list.delete(i)
  }
}

/**
 * An area of a page as it looks with some of its lines taken off -- for the
 * editor's preview of a text patch, which shows this where it used to paint
 * an opaque box, so what is on screen is what the export will produce.
 *
 * `doc` must be a SCRATCH copy: the lines really are removed from it.
 * `area` is MuPDF page space; the image covers it at `scale` pixels per
 * point. `removed` lists the line numbers that were actually taken -- a
 * line removeLines declines to take is still in the picture, and its patch
 * goes on covering it, as the export will.
 */
export function renderWithoutLines(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  targets: number[],
  area: { x: number; y: number; w: number; h: number },
  scale: number,
): { width: number; height: number; rgba: Uint8Array; removed: number[] } {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage
  try {
    const removed = [...removeLines(page, readLines(page), targets)]
    const bbox: [number, number, number, number] = [
      Math.floor(area.x * scale), Math.floor(area.y * scale),
      Math.ceil((area.x + area.w) * scale), Math.ceil((area.y + area.h) * scale),
    ]
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false)
    try {
      pixmap.clear(255)
      const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap)
      try {
        page.run(device, mupdf.Matrix.scale(scale, scale))
        device.close()
      } finally {
        device.destroy()
      }
      const width = pixmap.getWidth()
      const height = pixmap.getHeight()
      const rgb = pixmap.getPixels()
      const stride = pixmap.getStride()
      const rgba = new Uint8Array(width * height * 4)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const from = y * stride + x * 3
          const to = (y * width + x) * 4
          rgba[to] = rgb[from]!
          rgba[to + 1] = rgb[from + 1]!
          rgba[to + 2] = rgb[from + 2]!
          rgba[to + 3] = 255
        }
      }
      return { width, height, rgba, removed }
    } finally {
      pixmap.destroy()
    }
  } finally {
    page.destroy()
  }
}
