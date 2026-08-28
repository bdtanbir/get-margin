import * as mupdf from 'mupdf'
import type { PdfDocument } from '../engine.js'

/**
 * One image, where the page actually draws it.
 *
 * COORDINATE SPACE: MuPDF PAGE SPACE -- top-down, CropBox origin
 * normalised, /Rotate applied. The same space `buildQuadIndex` produces
 * and the same space a `textPatch`'s rect is stored in, so the two kinds
 * of patch need no conversion between them.
 */
export type ImagePlacement = {
  /**
   * Position in DRAW ORDER among the page's images -- the address a patch
   * refers to, and the reason `originalHash` exists to check it.
   *
   * Draw order rather than reading order because it is what both ends can
   * agree on: the app walks the source page and the writer re-walks the
   * assembled export copy, and only the content stream's own sequence is
   * the same in both.
   */
  index: number
  /** [x0, y0, x1, y1] in MuPDF page space. */
  bbox: [number, number, number, number]
  /** The SOURCE pixel dimensions, which is not how big it is on the page. */
  width: number
  height: number
  /** Identity: size and placement, hashed. See `placementHash`. */
  hash: string
}

/**
 * A stable identity for one placement.
 *
 * Size AND position, because neither alone is enough: a document can place
 * the same logo twice, and a page can have two images of identical
 * dimensions. Deliberately NOT a hash of the pixels -- decoding every
 * image on a page to address one of them costs a full decode per image,
 * per export, to answer a question the geometry already answers.
 *
 * Rounded to a tenth of a point before hashing, so a placement that
 * survives a re-save with floating-point noise still hashes the same. The
 * property being bought is "has the page changed under this edit", not
 * collision resistance.
 */
export function placementHash(
  width: number,
  height: number,
  bbox: [number, number, number, number],
): string {
  const round = (n: number) => Math.round(n * 10) / 10
  const key = `${width}x${height}@${bbox.map(round).join(',')}`
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * The box an image XObject covers, from the matrix that places it.
 *
 * An image XObject's own space is the UNIT SQUARE, so the CTM carries
 * position, size, flip and rotation together -- `write/objects/image.ts`
 * builds exactly such a matrix from the other direction. All four corners
 * are transformed rather than just two, because a matrix that flips or
 * rotates sends the corner that was the minimum to the maximum, and
 * reading only (0,0) and (1,1) then produces a box with negative width.
 */
/** A box in page space: [x0, y0, x1, y1]. */
type Box = [number, number, number, number]

/** No clip in force. Intersecting with it changes nothing. */
const UNCLIPPED: Box = [-Infinity, -Infinity, Infinity, Infinity]

function intersect(a: Box, b: Box): Box {
  return [
    Math.max(a[0], b[0]), Math.max(a[1], b[1]),
    Math.min(a[2], b[2]), Math.min(a[3], b[3]),
  ]
}

const isEmpty = (b: Box): boolean => b[2] <= b[0] || b[3] <= b[1]

function unitSquareBox(ctm: number[]): Box {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = ctm
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
    const x = a * u + c * v + e
    const y = b * u + d * v + f
    x0 = Math.min(x0, x); x1 = Math.max(x1, x)
    y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  return [x0, y0, x1, y1]
}

/**
 * Every image a page DRAWS, in draw order.
 *
 * BUILT FROM A DEVICE, not from `toStructuredText('preserve-images')`, and
 * the difference is not academic. MuPDF's structured-text device
 * rasterises a shading into a synthetic image block, so `onImageBlock`
 * reports gradients as images -- on a real US-Bangla e-ticket it claimed
 * three images on a page that draws two, the third being the grey wash
 * behind a table. A patch offered on that would cover nothing the user
 * could point at, because the gradient is drawn by the content stream and
 * would be redrawn underneath the cover on every render.
 *
 * A device sees what the page actually does, which is the only list worth
 * offering to delete or move.
 *
 * PAGE CONTENTS ONLY. An image inside an annotation's appearance stream is
 * not page content: it moves with the annotation, and covering the page
 * beneath it would leave it exactly where it was.
 *
 * `clipImageMask` is deliberately NOT counted as an image. It is the
 * stencil half of the `clipImageMask` + `fillImage` pair that draws a
 * transparent image -- counting it would report the e-ticket's logo twice,
 * once for its own mask. It DOES push a clip, like every other clip
 * operator. `fillImageMask` IS counted: a stencil filled with a colour is
 * a visible image in its own right, not the setup for one.
 *
 * THE CLIP IN FORCE IS PART OF THE ANSWER -- see `clips` below.
 */
export function pageImages(page: mupdf.PDFPage): ImagePlacement[] {
  const found: ImagePlacement[] = []

  /**
   * The clip stack, each entry already intersected with the one below it,
   * so the top is always the region currently visible.
   *
   * WITHOUT THIS the walk reports where an image WOULD land rather than
   * what actually shows. Page 2 of a real US-Bangla e-ticket draws its
   * icon grid through a clip: the matrix describes a 360.8x119.5pt box and
   * the clip trims it to 258.7x106.7pt, so the untrimmed box ran 15pt off
   * the right edge of the page. On screen that put the selection target
   * over the wrong content; on export it would have made the cover wipe
   * out a 50pt strip of the margin either side.
   */
  const clips: Box[] = [UNCLIPPED]
  const clip = (): Box => clips[clips.length - 1]!
  const pushClip = (box: Box): void => { clips.push(intersect(clip(), box)) }
  const popClip = (): void => { if (clips.length > 1) clips.pop() }

  const record = (image: mupdf.Image, ctm: number[]): void => {
    const bbox = intersect(unitSquareBox(ctm), clip())
    // Clipped away entirely: it is not on the page, so it is not offered.
    // The writer re-walks with this same function, so both ends agree
    // about what the indices mean.
    if (isEmpty(bbox)) return
    found.push({
      index: found.length,
      bbox,
      width: image.getWidth(),
      height: image.getHeight(),
      hash: placementHash(image.getWidth(), image.getHeight(), bbox),
    })
  }

  const device = new mupdf.Device({
    clipPath: (path: mupdf.Path, _evenOdd: boolean, ctm: number[]) => {
      pushClip(path.getBounds(null as never, ctm as never) as Box)
    },
    clipStrokePath: (path: mupdf.Path, stroke: mupdf.StrokeState, ctm: number[]) => {
      pushClip(path.getBounds(stroke, ctm as never) as Box)
    },
    /**
     * Text and stencil clips still have to PUSH, even where the bounds are
     * not worth computing, or the `popClip` that closes them would pop
     * somebody else's clip and widen it.
     *
     * A text clip narrows nothing here: glyph outlines are not a rectangle,
     * and the tightest honest rectangle around them is the one already in
     * force.
     */
    clipText: () => { pushClip(clip()) },
    clipImageMask: (_image: mupdf.Image, ctm: number[]) => {
      pushClip(unitSquareBox(ctm))
    },
    popClip: () => { popClip() },
    fillImage: (image: mupdf.Image, ctm: number[]) => record(image, ctm),
    fillImageMask: (image: mupdf.Image, ctm: number[]) => record(image, ctm),
  } as never)

  try {
    page.runPageContents(device, mupdf.Matrix.identity)
    device.close()
  } finally {
    device.destroy()
  }
  return found
}

export type PageImageIndex = { images: ImagePlacement[] }

/**
 * The image index for one page of an open document.
 *
 * The counterpart to `buildQuadIndex`, and shaped like it on purpose: the
 * app asks the worker for one of these per page, the worker caches it, and
 * the overlay draws targets from it. Wrapping the placement list in an
 * object rather than returning a bare array matches `PageQuadIndex` and
 * leaves room to carry per-page facts later without changing every caller.
 */
export function buildImageIndex(doc: PdfDocument, pageIndex: number): PageImageIndex {
  // Validates the index and range before a page is ever loaded, matching
  // buildQuadIndex's and renderPage's discipline.
  doc.pageGeometry(pageIndex)

  const page = doc._raw().loadPage(pageIndex) as mupdf.PDFPage
  try {
    return { images: pageImages(page) }
  } finally {
    page.destroy()
  }
}

/**
 * One of the page's images, as pixels, cropped to where it sits.
 *
 * WHY A RASTER AND NOT THE ORIGINAL STREAM. Probing a real e-ticket found
 * its images nested inside form XObjects rather than the page's own
 * resources, drawn through a `clipImageMask` stencil that carries the
 * transparency the image itself does not, one of them in an Indexed CMYK
 * space that `compress.ts` documents as failing to round-trip through a
 * pixmap. Re-referencing the original XObject at a new position would have
 * to solve the nesting, rebuild the stencil, and survive the colour space
 * -- and getting the stencil wrong paints a black box behind the logo.
 *
 * Asking the renderer for the pixels a READER would see solves all three
 * at once, because it is the same path that draws the page on screen.
 *
 * The cost is resolution: a crop is only as fine as `scale`. The caller
 * picks it from the ratio between the image's source pixels and the points
 * it occupies -- the ticket's logo is 1200px in 207.8pt, so a scale of 6
 * loses nothing visible.
 *
 * ONE WALK for the pixels and the hash. Two could disagree, and a patch
 * whose bytes are one image and whose hash is another refuses at export
 * for no reason the user can see.
 */
/**
 * The most pixels a crop may come to.
 *
 * A lift of half a page is a reasonable thing to ask for; a 200MB raster
 * is not a reasonable way to answer it. Past this the scale drops rather
 * than the request being refused -- a coarser copy is still the copy the
 * user asked for, where an error is not.
 */
const MAX_CROP_PIXELS = 4_000_000

/**
 * A rectangle of the page, rendered, as PNG.
 *
 * The pixmap's own box is in DEVICE space -- page space times the scale --
 * so the render lands in it with no further translation and only this
 * rectangle is ever rasterised.
 *
 * PAGE CONTENTS ONLY, matching `pageImages`: an annotation drawn over the
 * area is not page content and should not be baked into a copy of it.
 */
function renderRegion(
  page: mupdf.PDFPage,
  box: Box,
  scale: number,
): Uint8Array | undefined {
  const bounds = page.getBounds()
  const clipped = intersect(box, [bounds[0]!, bounds[1]!, bounds[2]!, bounds[3]!])
  if (isEmpty(clipped)) return undefined

  const w = clipped[2] - clipped[0]
  const h = clipped[3] - clipped[1]
  // Fit to the budget by dropping the scale, never by cropping further:
  // the caller asked for this area and gets all of it.
  const fitted = Math.min(scale, Math.sqrt(MAX_CROP_PIXELS / (w * h)))

  /**
   * Rounding out to whole pixels can push the result a row and a column
   * past the budget, so the box is measured and the scale corrected once.
   * One pass is enough: the error it corrects is at most one pixel per
   * axis, and the correction only ever shrinks.
   */
  const boxAt = (s: number): Box => [
    Math.floor(clipped[0] * s), Math.floor(clipped[1] * s),
    Math.ceil(clipped[2] * s), Math.ceil(clipped[3] * s),
  ]
  let device = boxAt(fitted)
  const area = (b: Box): number => (b[2] - b[0]) * (b[3] - b[1])
  if (area(device) > MAX_CROP_PIXELS) {
    device = boxAt(fitted * Math.sqrt(MAX_CROP_PIXELS / area(device)))
  }
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, device, false)
  let drawer: mupdf.DrawDevice | undefined
  try {
    // White, so anything the page leaves untouched inside the box reads as
    // paper rather than as the uninitialised memory it would be.
    pixmap.clear(255)
    drawer = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap)
    // The scale the DEVICE box was built at, so the render lands in it
    // exactly -- taking `fitted` here after a correction would draw the
    // page slightly larger than the pixmap that has to hold it.
    const drawn = (device[2] - device[0]) / w
    page.runPageContents(drawer, mupdf.Matrix.scale(drawn, drawn))
    drawer.close()
    return pixmap.asPNG()
  } finally {
    drawer?.destroy()
    pixmap.destroy()
  }
}

/**
 * One of the page's images, as pixels, cropped to where it sits.
 *
 * WHY A RASTER AND NOT THE ORIGINAL STREAM. Probing a real e-ticket found
 * its images nested inside form XObjects rather than the page's own
 * resources, drawn through a `clipImageMask` stencil that carries the
 * transparency the image itself does not, one of them in an Indexed CMYK
 * space that `compress.ts` documents as failing to round-trip through a
 * pixmap. Re-referencing the original XObject at a new position would have
 * to solve the nesting, rebuild the stencil, and survive the colour space
 * -- and getting the stencil wrong paints a black box behind the logo.
 *
 * Asking the renderer for the pixels a READER would see solves all three
 * at once, because it is the same path that draws the page on screen.
 *
 * The cost is resolution: a crop is only as fine as `scale`. The caller
 * picks it from the ratio between the image's source pixels and the points
 * it occupies -- the ticket's logo is 1200px in 207.8pt, so a scale of 6
 * loses nothing visible.
 *
 * ONE WALK for the pixels and the hash. Two could disagree, and a patch
 * whose bytes are one image and whose hash is another refuses at export
 * for no reason the user can see.
 */
export function cropImage(
  doc: PdfDocument,
  pageIndex: number,
  imageIndex: number,
  scale: number,
): { data: Uint8Array; hash: string; bbox: Box } | undefined {
  doc.pageGeometry(pageIndex)
  const page = doc._raw().loadPage(pageIndex) as mupdf.PDFPage
  try {
    const place = pageImages(page)[imageIndex]
    if (!place) return undefined
    const data = renderRegion(page, place.bbox, scale)
    return data ? { data, hash: place.hash, bbox: place.bbox } : undefined
  } finally {
    page.destroy()
  }
}

/**
 * ANY rectangle of the page, as pixels.
 *
 * The escape hatch from `cropImage`, and it exists because a great deal of
 * what a reader would call "the logo" is not an image at all. Page 2 of a
 * real US-Bangla e-ticket draws the same logo page 1 embeds as a 1200x286
 * raster using 21 vector paths instead, so no image walk can reach it and
 * no clustering heuristic can decide where it ends without sometimes
 * taking the rule beside it.
 *
 * Letting the user draw the boundary answers both problems at once, and
 * the rendering is identical either way -- which is the point: to this
 * function a logo, a barcode, a table and a paragraph are all just an area
 * of the page.
 *
 * `rect` is MuPDF PAGE space (top-down), like every other geometry in this
 * module. A region reaching past the page is CLAMPED rather than refused:
 * a drag that overshoots the edge means "to the edge".
 */
export function cropRegion(
  doc: PdfDocument,
  pageIndex: number,
  rect: { x: number; y: number; w: number; h: number },
  scale: number,
): { data: Uint8Array } | undefined {
  doc.pageGeometry(pageIndex)
  if (rect.w <= 0 || rect.h <= 0) return undefined
  const page = doc._raw().loadPage(pageIndex) as mupdf.PDFPage
  try {
    const data = renderRegion(
      page,
      [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h],
      scale,
    )
    return data ? { data } : undefined
  } finally {
    page.destroy()
  }
}
