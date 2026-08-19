import { removeBackground } from './removeBackground'

/**
 * Rasterise a set of view-space strokes into a transparent PNG.
 *
 * Used by the modal's Draw and Type tabs, which both end up with something
 * drawn on a canvas that needs to become the `data` of a signature object.
 * Upload goes through importImage first and then `cleanUpload` below.
 */
export async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
  if (!blob) throw new Error('Could not create the signature image.')
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * Trim fully-transparent margins so the placed signature's box hugs the
 * ink. Without this, a signature drawn in the corner of the pad places a
 * mostly-empty rectangle whose visible handles are nowhere near the marks.
 */
export function inkBounds(img: ImageData): { x: number; y: number; w: number; h: number } | undefined {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3]! > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < minX) return undefined
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/**
 * A photographed or scanned signature, cropped to its ink and with the paper
 * turned transparent. Returns undefined when nothing survived the threshold,
 * which is the honest answer for a blank or blown-out photo -- better than
 * placing an empty box the user cannot see.
 */
export async function cleanUpload(bitmap: ImageBitmap): Promise<
  { data: Uint8Array; w: number; h: number } | undefined
> {
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not process that image.')
  ctx.drawImage(bitmap, 0, 0)

  const cleaned = removeBackground(ctx.getImageData(0, 0, canvas.width, canvas.height))
  const box = inkBounds(cleaned)
  if (!box) return undefined
  ctx.putImageData(cleaned, 0, 0)

  const cropped = document.createElement('canvas')
  cropped.width = box.w
  cropped.height = box.h
  const cctx = cropped.getContext('2d')
  if (!cctx) throw new Error('Could not process that image.')
  cctx.drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h)

  return { data: await canvasToPng(cropped), w: box.w, h: box.h }
}
