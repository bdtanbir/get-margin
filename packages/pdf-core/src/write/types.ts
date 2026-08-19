import type { Rect } from '@margin/transform'

export type ObjectId = string
export type PageId = string

export type ObjectKind =
  | 'text' | 'image' | 'rect' | 'ellipse' | 'line' | 'arrow'
  | 'ink' | 'highlight' | 'underline' | 'strikeout'
  | 'whiteout' | 'link' | 'signature'

/** sRGB, each channel 0..1 — the range MuPDF's colour setters take. */
export type Color = [number, number, number]

export type BaseObject = {
  id: ObjectId
  pageId: PageId
  kind: ObjectKind
  /** PDF user space, UNROTATED. Origin bottom-left. Never view pixels. */
  rect: Rect
  /** The object's own rotation in degrees, independent of the page's. */
  rotation: number
  z: number
  locked: boolean
  /** 0..1 */
  opacity: number
}

export type TextObject = BaseObject & {
  kind: 'text'
  text: string
  fontFamily: string
  fontSize: number
  color: Color
  align: 'left' | 'center' | 'right'
}

export type ImageObject = BaseObject & {
  kind: 'image'
  /** PNG or JPEG bytes, already decoded, downscaled, and EXIF-normalised. */
  data: Uint8Array
  mime: 'image/png' | 'image/jpeg'
}

export type ShapeObject = BaseObject & {
  kind: 'rect' | 'ellipse' | 'line' | 'arrow'
  stroke: Color | null
  strokeWidth: number
  fill: Color | null
}

export type WhiteoutObject = BaseObject & { kind: 'whiteout'; fill: Color }

export type InkObject = BaseObject & {
  kind: 'ink'
  /** One entry per stroke; each is a flat [x0,y0,x1,y1,...] in PDF space. */
  strokes: number[][]
  color: Color
  strokeWidth: number
}

export type MarkupObject = BaseObject & {
  kind: 'highlight' | 'underline' | 'strikeout'
  /**
   * 8 numbers per quad, in MuPDF PAGE space (top-down, CropBox-origin
   * normalised, /Rotate applied) -- NOT the raw bottom-up PDF space every
   * `rect` above uses. This is deliberate: buildQuadIndex (Task 36)
   * produces page space and setQuadPoints (Task 38) consumes it, so a
   * conversion in either direction would be a round trip through the wrong
   * space. `rect` on a MarkupObject still follows the usual rule and goes
   * through toAnnotSpace.
   */
  quads: number[][]
  color: Color
}

export type LinkObject = BaseObject & { kind: 'link'; uri: string }

export type SignatureObject = BaseObject & {
  kind: 'signature'
  data: Uint8Array
  mime: 'image/png'
}

export type EditObject =
  | TextObject | ImageObject | ShapeObject | WhiteoutObject
  | InkObject | MarkupObject | LinkObject | SignatureObject

export type EditDocument = {
  version: number
  /** SHA-256 of the original file. Guards replay against the wrong source. */
  sourceHash: string
  pageOrder: PageId[]
  pages: Record<PageId, { sourceIndex: number }>
  objects: Record<ObjectId, EditObject>
  nextZ: number
}

export type Op =
  | { type: 'addObject'; object: EditObject }
  | { type: 'updateObject'; id: ObjectId; patch: Partial<EditObject> }
  | { type: 'deleteObject'; id: ObjectId }
  | { type: 'reorder'; id: ObjectId; z: number }

export const EDIT_DOCUMENT_VERSION = 1
