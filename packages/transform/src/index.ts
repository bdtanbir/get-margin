/**
 * The coordinate contract for get-margin.
 *
 * PDF user space: origin bottom-left, y-up, units are points (1/72 inch).
 * View space:     origin top-left, y-down, units are CSS pixels.
 *
 * All stored geometry in this application is UNROTATED PDF user space.
 * Zoom and page rotation are view concerns and never mutate stored data.
 *
 * `/Rotate N` in a PDF means "display this page rotated N degrees CLOCKWISE".
 *
 * MuPDF's `toPixmap` bakes three things into its render space together: the
 * CropBox origin translated to (0,0), a top-down y-flip, and `/Rotate`. This
 * module's `pdfToView` reproduces exactly that composed transform so that
 * raw PDF-space geometry (annotation rects, quads, ...) lands on the
 * rendered pixmap without any other module doing its own coordinate math.
 */

export type Point = { x: number; y: number }
/** PDF-space rect. (x, y) is the BOTTOM-LEFT corner; w/h are always positive. */
export type Rect = { x: number; y: number; w: number; h: number }
/** View-space rect. (x, y) is the TOP-LEFT corner; w/h are always positive. */
export type ViewRect = { x: number; y: number; w: number; h: number }
export type Rotation = 0 | 90 | 180 | 270
export type PageGeometry = {
  /** [x0, y0, x1, y1] — CropBox if present, else MediaBox. Origin may be non-zero. */
  cropBox: [number, number, number, number]
  rotate: Rotation
}

export function normalizeRotation(deg: number): Rotation {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360
  return r as Rotation
}

/** Unrotated page extent in points. */
export function pageSizePt(g: PageGeometry): { w: number; h: number } {
  const [x0, y0, x1, y1] = g.cropBox
  return { w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }
}

/** Displayed size in CSS pixels, accounting for quarter-turn dimension swap. */
export function pageViewSize(g: PageGeometry, zoom: number): { width: number; height: number } {
  const { w, h } = pageSizePt(g)
  const swap = g.rotate === 90 || g.rotate === 270
  return { width: (swap ? h : w) * zoom, height: (swap ? w : h) * zoom }
}

export function pdfToView(p: Point, g: PageGeometry, zoom: number): Point {
  const [x0, y0] = g.cropBox
  const { w, h } = pageSizePt(g)
  // Local unrotated coords, y still up.
  const lx = p.x - x0
  const ly = p.y - y0
  // Unrotated display coords, y now down.
  const dx = lx
  const dy = h - ly

  let vx: number
  let vy: number
  switch (g.rotate) {
    case 0:   vx = dx;     vy = dy;     break
    case 90:  vx = h - dy; vy = dx;     break
    case 180: vx = w - dx; vy = h - dy; break
    case 270: vx = dy;     vy = w - dx; break
  }
  return { x: vx * zoom, y: vy * zoom }
}

export function viewToPdf(p: Point, g: PageGeometry, zoom: number): Point {
  const [x0, y0] = g.cropBox
  const { w, h } = pageSizePt(g)
  const vx = p.x / zoom
  const vy = p.y / zoom

  let dx: number
  let dy: number
  switch (g.rotate) {
    case 0:   dx = vx;     dy = vy;     break
    case 90:  dx = vy;     dy = h - vx; break
    case 180: dx = w - vx; dy = h - vy; break
    case 270: dx = w - vy; dy = vx;     break
  }
  return { x: dx + x0, y: h - dy + y0 }
}

/**
 * Transform a PDF rect to a view rect. Both corners are transformed and then
 * re-normalized, because rotation moves which corner is topmost-leftmost.
 */
export function pdfRectToView(r: Rect, g: PageGeometry, zoom: number): ViewRect {
  const a = pdfToView({ x: r.x, y: r.y }, g, zoom)
  const b = pdfToView({ x: r.x + r.w, y: r.y + r.h }, g, zoom)
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  }
}

export function viewRectToPdf(r: ViewRect, g: PageGeometry, zoom: number): Rect {
  const a = viewToPdf({ x: r.x, y: r.y }, g, zoom)
  const b = viewToPdf({ x: r.x + r.w, y: r.y + r.h }, g, zoom)
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  }
}

/**
 * SVG overlay viewBox — always the UNROTATED extent with a zero origin.
 * Combined with svgRootTransform(), this is what lets objects render at their
 * raw stored PDF coordinates with no per-object math (spec §1.3, Layer 2).
 */
export function svgViewBox(g: PageGeometry): string {
  const { w, h } = pageSizePt(g)
  return `0 0 ${w} ${h}`
}

/**
 * Transform for the SVG overlay's single root <g>. Applies the CropBox origin
 * shift, the y-flip, and the page rotation in one place.
 *
 * Read as right-to-left: translate cropBox origin to 0, flip y, then rotate.
 */
export function svgRootTransform(g: PageGeometry): string {
  const [x0, y0] = g.cropBox
  const { w, h } = pageSizePt(g)
  const flip = `translate(0 ${h}) scale(1 -1) translate(${-x0} ${-y0})`
  switch (g.rotate) {
    case 0:   return flip
    case 90:  return `translate(${h} 0) rotate(90) ${flip}`
    case 180: return `translate(${w} ${h}) rotate(180) ${flip}`
    case 270: return `translate(0 ${w}) rotate(270) ${flip}`
  }
}
