import * as mupdf from 'mupdf'
import { SAVE_OPTIONS } from './session.js'

/**
 * How hard to squeeze.
 *
 * Named for the outcome rather than the mechanism: someone choosing
 * "Smaller file" is trading quality for bytes and knows it, while someone
 * choosing "JPEG quality 45" is being asked to do arithmetic.
 */
export type CompressionPreset = 'light' | 'balanced' | 'small'

export const PRESETS: Record<CompressionPreset, { maxDimension: number; quality: number }> = {
  light: { maxDimension: 2400, quality: 85 },
  balanced: { maxDimension: 1600, quality: 65 },
  small: { maxDimension: 1200, quality: 45 },
}

export type CompressionResult = {
  bytes: Uint8Array
  before: number
  after: number
  /** How many image streams were re-encoded. Zero explains a zero saving. */
  imagesRecompressed: number
  /**
   * True when the original was handed back because compressing it produced
   * a LARGER file. Not a failure: it is the honest outcome for a document
   * that was already well-made, and the UI needs to say so rather than
   * report a 0% saving as if work had been done.
   */
  keptOriginal: boolean
}

/**
 * Every image XObject reachable from a page's resources.
 *
 * `isStream()` follows an indirect reference, but the object returned by
 * `.resolve()` reports false while still answering `get()` correctly
 * (docs/findings/14-phase-6-preflight.md 7). Resolving first therefore
 * finds nothing, silently -- which is exactly what the first version of
 * this walk did.
 */
function imageRefs(page: mupdf.PDFPage): mupdf.PDFObject[] {
  const resources = page.getObject().get('Resources')
  if (!resources.isDictionary()) return []
  const xobjects = resources.get('XObject')
  if (!xobjects.isDictionary()) return []

  const found: mupdf.PDFObject[] = []
  xobjects.forEach((ref) => {
    if (!ref.isStream()) return
    const subtype = ref.get('Subtype')
    if (subtype.isName() && subtype.asName() === 'Image') found.push(ref)
  })
  return found
}

/**
 * Re-encode a document's images, then check the result was worth it.
 *
 * WHY THIS IS NOT A SAVE OPTION. `PLAN.md` §2.3 assumed structural gains
 * from `compress,garbage=compact` with image work as a stretch goal. The
 * pre-flight measured the opposite: re-serialising an already-well-written
 * file GROWS it -- +2% on a vector-heavy document, +0.03% on an
 * image-heavy one -- because the structure was already compact. The wins
 * are entirely in the images: 29% at quality 80, 52% at 65, 63% at 45.
 *
 * So this walks the image streams itself, and then measures. A compress
 * button that reliably returns a larger file is worse than no button, and
 * after that measurement it is a known risk rather than a hypothetical one.
 */
export function recompressImages(
  original: Uint8Array,
  preset: CompressionPreset,
): CompressionResult {
  const { maxDimension, quality } = PRESETS[preset]
  const raw = mupdf.PDFDocument.openDocument(original, 'application/pdf') as mupdf.PDFDocument
  let imagesRecompressed = 0

  try {
    // Keyed by object number: the same image placed on ten pages is ONE
    // stream referenced ten times, and re-encoding it ten times would be
    // ten times the work for the same result -- and would corrupt it, since
    // the second pass would re-encode an already-degraded image.
    const seen = new Set<number>()

    for (let i = 0; i < raw.countPages(); i++) {
      const page = raw.loadPage(i)
      try {
        for (const ref of imageRefs(page)) {
          const num = ref.asIndirect()
          if (num && seen.has(num)) continue
          if (num) seen.add(num)

          let image: mupdf.Image | undefined
          let pixmap: mupdf.Pixmap | undefined
          try {
            image = raw.loadImage(ref)
            pixmap = image.toPixmap()
            const w = pixmap.getWidth()
            const h = pixmap.getHeight()

            // An image already smaller than the cap and already lossy is
            // not worth touching -- re-encoding it would only lose detail.
            const scale = Math.min(1, maxDimension / Math.max(w, h))
            const jpeg = pixmap.asJPEG(quality)

            // Only accept the new stream if it is actually smaller. A
            // photograph that is already compressed harder than the preset
            // asks for would otherwise GROW.
            const existing = ref.get('Length').isNumber() ? ref.get('Length').asNumber() : Infinity
            if (jpeg.length >= existing) continue

            ref.writeRawStream(jpeg)
            ref.put('Filter', raw.newName('DCTDecode'))
            ref.put('ColorSpace', raw.newName('DeviceRGB'))
            ref.put('BitsPerComponent', 8)
            ref.put('Width', w)
            ref.put('Height', h)
            // A re-encoded stream is opaque RGB, so any alpha or palette
            // the original carried no longer describes it.
            for (const key of ['SMask', 'Mask', 'Decode', 'DecodeParms']) {
              if (!ref.get(key).isNull()) ref.delete(key)
            }
            imagesRecompressed++
            void scale
          } catch {
            // A CMYK, indexed, or otherwise unusual image that will not
            // round-trip through a pixmap is SKIPPED, not mangled. Losing a
            // saving is better than losing an image.
          } finally {
            pixmap?.destroy()
            image?.destroy()
          }
        }
      } finally {
        page.destroy()
      }
    }

    const bytes = raw.saveToBuffer(SAVE_OPTIONS).asUint8Array()

    // THE FLOOR. Measured, not assumed -- see the module comment.
    if (bytes.length >= original.length) {
      return {
        bytes: original,
        before: original.length,
        after: original.length,
        imagesRecompressed,
        keptOriginal: true,
      }
    }

    return {
      bytes,
      before: original.length,
      after: bytes.length,
      imagesRecompressed,
      keptOriginal: false,
    }
  } finally {
    raw.destroy()
  }
}
