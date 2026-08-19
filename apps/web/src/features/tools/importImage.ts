/**
 * Decode, normalise, downscale, and re-encode a user-supplied image so it is
 * safe to embed in a PDF.
 *
 * Spec 2.1: a 12MP phone photo dropped on a page must NOT become a 4MB
 * embed. The export path does not subset or recompress what it is given
 * (write/objects/image.ts embeds the bytes as-is), so this is the only place
 * that budget is enforced.
 */

/** Refused outright. Large enough for any real photo, small enough to decode. */
export const MAX_INPUT_BYTES = 25 * 1024 * 1024

/** Longest edge after downscaling. 2000px covers a full-page image at 200dpi. */
export const MAX_EDGE = 2000

export const JPEG_QUALITY = 0.85

export type ImportedImage = {
  data: Uint8Array
  mime: 'image/png' | 'image/jpeg'
  /** Pixel dimensions AFTER downscaling — what the placement rect derives from. */
  w: number
  h: number
}

const ACCEPTED = /^image\/(png|jpeg|webp|gif|bmp)$/

/**
 * The offending size is reported to one decimal while the cap is reported
 * whole. Rounding both would produce "That image is 25 MB ... up to 25 MB"
 * for a file barely over the limit -- a message that reads like a bug.
 */
function mb(bytes: number, decimals = 0): string {
  return `${(bytes / (1024 * 1024)).toFixed(decimals)} MB`
}

/** Longest edge capped at MAX_EDGE, aspect preserved, never upscaled. */
export function fitWithin(w: number, h: number, max = MAX_EDGE): { w: number; h: number } {
  const longest = Math.max(w, h)
  if (longest <= max) return { w, h }
  const scale = max / longest
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) }
}

/**
 * True if any pixel is not fully opaque.
 *
 * Worth the readback: choosing PNG for everything would keep a photo at
 * several MB, and choosing JPEG for everything would silently fill a
 * transparent logo's background with black. One pass over at most 4M pixels
 * costs a few milliseconds and decides which of those failures to avoid.
 */
function hasAlpha(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true
  return false
}

async function toBytes(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality))
  if (!blob) throw new Error('Could not process that image.')
  return new Uint8Array(await blob.arrayBuffer())
}

export async function importImage(file: File): Promise<ImportedImage> {
  if (!ACCEPTED.test(file.type)) {
    throw new Error('That file is not an image the editor can place.')
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error(
      `That image is ${mb(file.size, 1)}. The editor places images up to ${mb(MAX_INPUT_BYTES)}.`,
    )
  }

  // `imageOrientation: 'from-image'` is what applies EXIF rotation. Without
  // it a photo taken in portrait embeds sideways, and no later transform can
  // recover the intent because the orientation tag is gone by then.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const { w, h } = fitWithin(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not process that image.')
    ctx.drawImage(bitmap, 0, 0, w, h)

    const alpha = hasAlpha(ctx.getImageData(0, 0, w, h).data)
    const mime = alpha ? 'image/png' : 'image/jpeg'
    return { data: await toBytes(canvas, mime, JPEG_QUALITY), mime, w, h }
  } finally {
    // ImageBitmap holds a decoded full-resolution surface; leaving it to the
    // GC is how importing a dozen photos runs the tab out of memory.
    bitmap.close()
  }
}

/**
 * A placement rect in PDF points for an image of `w`x`h` pixels, centred on
 * `centre`, scaled down to fit `maxPt` on its longest edge. Pixels are
 * treated as points (72dpi) before that cap, so a screenshot lands at a
 * plausible size rather than filling three pages.
 */
export function placementRect(
  image: { w: number; h: number },
  centre: { x: number; y: number },
  maxPt = 300,
): { x: number; y: number; w: number; h: number } {
  const { w, h } = fitWithin(image.w, image.h, maxPt)
  return { x: centre.x - w / 2, y: centre.y - h / 2, w, h }
}
