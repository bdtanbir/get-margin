import { normalizeRotation, type PageGeometry, type Rotation } from '@margin/transform'

/**
 * Minimal structural type for a mupdf PDFObject — avoids leaking mupdf types
 * outward. Adapted from the real `mupdf@1.28.0` `PDFObject` surface
 * (`packages/pdf-core/node_modules/mupdf/dist/mupdf.d.ts`), which differs
 * from an earlier draft of this type in a few ways:
 *  - `get()` is never `undefined` — a missing key resolves to a real object
 *    whose `isNull()` is true, not to `undefined`. `key` may be a string
 *    (dictionary lookup) or a number (array index) — mupdf accepts both
 *    through the same variadic `get(...path)`.
 *  - `isArray`, `isNumber` and `isNull` are always present, not optional.
 *  - There is no `asFloat()` — `asNumber()` covers both integer and real
 *    PDF number objects.
 */
export type RawObj = {
  get: (key: string | number) => RawObj
  isArray: () => boolean
  isNumber: () => boolean
  asNumber: () => number
  isNull: () => boolean
}

function isPresent(o: RawObj | undefined): o is RawObj {
  return o !== undefined && !o.isNull()
}

function num(o: RawObj | undefined): number | undefined {
  if (!isPresent(o)) return undefined
  if (!o.isNumber()) return undefined
  const v = o.asNumber()
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * Resolve an inheritable page attribute. /MediaBox, /CropBox, /Resources and
 * /Rotate may all be omitted on a page and inherited from the Pages tree —
 * this is legal PDF and common in real files.
 */
function inherited(pageObj: RawObj, key: string, maxDepth = 32): RawObj | undefined {
  let node: RawObj | undefined = pageObj
  for (let d = 0; d < maxDepth && node; d++) {
    const v = node.get(key)
    if (isPresent(v)) return v
    node = node.get('Parent')
    if (!isPresent(node)) return undefined
  }
  return undefined
}

function readBox(pageObj: RawObj, key: string): [number, number, number, number] | undefined {
  const arr = inherited(pageObj, key)
  if (!isPresent(arr) || !arr.isArray()) return undefined
  const vals = [0, 1, 2, 3].map((i) => num(arr.get(i)))
  if (vals.some((v) => v === undefined)) return undefined
  const [a, b, c, d] = vals as [number, number, number, number]
  // PDF boxes may be stored with corners in any order; normalize to min/max.
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)]
}

const LETTER: [number, number, number, number] = [0, 0, 612, 792]

/**
 * Derive unrotated page geometry from the raw page dictionary.
 *
 * CropBox is intersected with MediaBox per PDF 32000-1 §14.11.2: a CropBox
 * extending beyond the MediaBox is invalid and must be clipped, not honoured.
 */
export function geometryFromPageObject(pageObj: RawObj): PageGeometry {
  const media = readBox(pageObj, 'MediaBox') ?? LETTER
  const crop = readBox(pageObj, 'CropBox')

  let box = media
  if (crop) {
    const x0 = Math.max(crop[0], media[0])
    const y0 = Math.max(crop[1], media[1])
    const x1 = Math.min(crop[2], media[2])
    const y1 = Math.min(crop[3], media[3])
    // Degenerate intersection means a malformed CropBox — fall back to MediaBox.
    box = x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : media
  }

  const rotateRaw = num(inherited(pageObj, 'Rotate')) ?? 0
  const rotate: Rotation = normalizeRotation(rotateRaw)

  return { cropBox: box, rotate }
}
