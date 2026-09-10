import {
  pdfRectToView, viewRectToPdf, viewToPdf,
  type PageGeometry, type Point, type Rect,
} from '@margin/transform'


/**
 * THE THREE CONVENTIONS. Read this before touching any object writer.
 *
 * The write path speaks three different coordinate languages at once, and
 * mixing them produces output that looks correct on an unrotated,
 * origin-zero letter page and is wrong everywhere else. This module is the
 * only place any of the conversions happens.
 *
 * ---------------------------------------------------------------------
 * CONVENTION A -- annotation setters: PAGE SPACE AT SCALE 1
 * ---------------------------------------------------------------------
 * setRect / setQuadPoints / setLine / getRect are top-down, y=0 at the TOP
 * of the CropBox, with the CropBox origin already normalised to (0,0) and
 * /Rotate already applied. MuPDF's binding flips y transparently on every
 * get and set.
 *
 * This was MEASURED in Phase 0 (docs/findings/02-write-path.md Q2), two
 * independent ways: setRect([72,400,200,460]) read back identically while
 * the raw on-disk /Rect was [71,331,201,393]; and pixel-sampling a render
 * matched the unflipped formula within 1-3px while the naive PDF-spec flip
 * was off by 120-140px.
 *
 * Traps:
 *   - Pass points at SCALE 1, never zoom-scaled view pixels. A zoom-scaled
 *     rect is accepted silently and lands the annotation at a multiple of
 *     the correct offset.
 *   - Do NOT apply a manual bottom-up flip. MuPDF already did it.
 *   - Do NOT re-subtract the CropBox origin yourself; pdfRectToView handles
 *     it and MuPDF has already zeroed it (getBounds() === getBounds('CropBox'),
 *     docs/findings/01-read-path.md Q5).
 *
 * ---------------------------------------------------------------------
 * CONVENTION B -- content-stream operators: RAW PDF USER SPACE
 * ---------------------------------------------------------------------
 * Page content streams are drawn in unrotated PDF user space: origin
 * bottom-left, y-up, CropBox origin NOT normalised. Since every EditObject
 * already stores its rect in exactly that space, the conversion is the
 * identity -- and `toContentSpace` exists anyway, as a named seam, so that
 * writers call a documented conversion instead of silently assuming one.
 *
 * Phase 0 did NOT verify this end-to-end: it confirmed the Font/Text/Device
 * primitives render and measure correctly into a standalone Pixmap, but
 * explicitly noted that "wiring this into an actual page content-stream
 * edit was not tested". test/write/pinning.test.ts is what verifies it, and
 * it runs on every commit. VERIFIED end-to-end by that test in Task 24, on
 * an origin-zero page, a non-zero-CropBox page, and a quarter-turned page.
 */

/**
 * ---------------------------------------------------------------------
 * CONVENTION C -- extraction geometry: MuPDF PAGE SPACE
 * ---------------------------------------------------------------------
 * `toStructuredText`, `getBounds()` and `buildQuadIndex` do NOT speak either
 * of the two conventions above. They speak MuPDF PAGE space: top-down, y=0
 * at the top, CropBox origin normalised to (0,0), and /Rotate ALREADY
 * APPLIED -- so on a quarter-turned page its axes are the SWAPPED ones.
 * `page.getBounds()` on a /Rotate 90 page whose MediaBox is [0 0 420 595]
 * returns [0, 0, 595, 420], measured in test/write/rotatedPatch.test.ts.
 *
 * It is identical to view space at zoom 1, which is why the conversions
 * below are `viewToPdf`/`viewRectToPdf` at zoom 1 rather than a second copy
 * of the rotation table.
 *
 * THE TRAP THIS EXISTS TO CLOSE. Convention C differs from Convention B by
 * a y-flip alone ONLY when /Rotate is 0. Writers that flipped against the
 * unrotated CropBox height by hand were therefore correct on every
 * unrotated page and wrong on every turned one: the cover landed off the
 * page and the redraw came out at a right angle to the line it replaced.
 * That is what a downloaded /Rotate 90 invoice looked like before
 * `pageBoxToContent` existed.
 *
 * ORIENTATION IS NOT POSITION. Placing a redraw correctly is only half of
 * it: a content stream drawn axis-aligned on a turned page is turned with
 * the page when it is displayed. Text and images that must come out
 * matching what they replace carry the turn in their own matrix -- see
 * `pageDirToContent` and `textMatrix`.
 */

/** Convention A. Returns a MuPDF Rect: [x0, y0, x1, y1], top-down page space. */
export function toAnnotSpace(rect: Rect, g: PageGeometry): [number, number, number, number] {
  // Scale 1 -- unscaled points, NOT zoom-scaled view pixels.
  const v = pdfRectToView(rect, g, 1)
  return [v.x, v.y, v.x + v.w, v.y + v.h]
}

/** Convention B. Identity by construction — see the module comment. */
export function toContentSpace(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
}

/** Formats a number for a content stream: no exponent notation, 4dp max. */
export function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}


/** Convention C -> B. A MuPDF page-space box [x0,y0,x1,y1] as a content rect. */
export function pageBoxToContent(box: [number, number, number, number], g: PageGeometry): Rect {
  const [x0, y0, x1, y1] = box
  return viewRectToPdf(
    { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) },
    g,
    1,
  )
}

/** Convention C -> B, for a single point such as a pen origin. */
export function pagePointToContent(p: Point, g: PageGeometry): Point {
  return viewToPdf(p, g, 1)
}

/**
 * Convention C -> B, for a DISTANCE.
 *
 * A delta has no origin, so it cannot go through `pagePointToContent` --
 * that would add the CropBox origin to a length. Taken as the difference
 * between two mapped points because the map is affine: this stays correct
 * by construction if the rotation table in @margin/transform ever changes,
 * where a second hand-written copy of that table would silently drift.
 *
 * On an unrotated page this reduces to `{ x: d.x, y: -d.y }` -- the sign
 * flip every caller used to write inline, page space being top-down and the
 * content stream bottom-up.
 */
export function pageDeltaToContent(d: Point, g: PageGeometry): Point {
  const o = viewToPdf({ x: 0, y: 0 }, g, 1)
  const p = viewToPdf(d, g, 1)
  return { x: p.x - o.x, y: p.y - o.y }
}

/**
 * The content-space unit advance of a line, from its page-space direction.
 *
 * MuPDF hands `beginLine` a writing direction in page space: [1,0] for text
 * that reads left-to-right on screen, [0,1] for a caption running down it.
 * Rotating that through the page's own /Rotate recovers the direction the
 * ORIGINAL run was drawn in, in raw user space -- which is what a
 * replacement has to be drawn in to come out looking like the thing it
 * replaced. Both halves matter: the invoice that prompted this has
 * direction [1,0] on a /Rotate 90 page and is drawn along user-space +y,
 * while the `rotated` fixture has direction [0,1] on a /Rotate 90 page and
 * is drawn along user-space +x.
 *
 * Degenerate input falls back to +x rather than producing a zero matrix,
 * which would collapse every glyph onto one point.
 */
export function pageDirToContent(dir: Point, g: PageGeometry): Point {
  const d = pageDeltaToContent(dir, g)
  const len = Math.hypot(d.x, d.y)
  if (!Number.isFinite(len) || len < 1e-9) return { x: 1, y: 0 }
  return { x: d.x / len, y: d.y / len }
}

/**
 * `Tm` operands that set text running along `u` from the pen at (e, f).
 *
 * A text matrix's first column is the advance direction and its second is
 * "up", so up is `u` turned a quarter-turn counter-clockwise. At u = (1,0)
 * this is the identity `1 0 0 1 e f` every unrotated caller wrote by hand.
 */
export function textMatrix(u: Point, e: number, f: number): string {
  return `${num(u.x)} ${num(u.y)} ${num(-u.y)} ${num(u.x)} ${num(e)} ${num(f)} Tm`
}

/**
 * A stored content-space rect, in page space.
 *
 * The inverse of what `pageBoxToContent` does, and the direction an object
 * that LAYS SOMETHING OUT wants: alignment, line stacking and a rotation
 * about a box's centre are all things the user specified while looking at
 * the page, so they are only meaningful in the space the user was looking
 * at. Laying out in page space and converting the finished anchor point is
 * what makes an export agree with the on-screen preview on a turned page.
 */
export function contentRectToPage(rect: Rect, g: PageGeometry): Rect {
  const v = pdfRectToView(rect, g, 1)
  return { x: v.x, y: v.y, w: v.w, h: v.h }
}

/**
 * The page's own axes, in content space: which way is right, and which is up.
 *
 * Both are unit vectors, because /Rotate is only ever a quarter turn. On an
 * unrotated page they are (1,0) and (0,1), which is why every writer that
 * used a literal `1 0 0 1` or `w 0 0 h` was correct there and only there.
 * `up` comes from page-space -y: page space is top-down, so "up the screen"
 * is where y decreases.
 */
export function pageBasis(g: PageGeometry): { right: Point; up: Point } {
  return {
    right: pageDeltaToContent({ x: 1, y: 0 }, g),
    up: pageDeltaToContent({ x: 0, y: -1 }, g),
  }
}
