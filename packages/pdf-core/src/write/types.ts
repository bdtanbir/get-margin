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

export type SourceId = string

/**
 * A page in the edited document: where it came from, and what has been done
 * to it that is not an object drawn on top.
 */
export type PageEntry = {
  /** Which opened file this page came from. Merge is why this exists. */
  sourceId: SourceId
  /** Index in THAT source, not in the edited document. */
  sourceIndex: number
  /**
   * Added to the source page's own /Rotate. Always normalised to one of
   * 0/90/180/270 -- an unbounded accumulator would eventually be compared
   * against a normalised source rotation and disagree.
   */
  rotation: number
  /**
   * Overrides the source page's CropBox. RAW PDF user space, like every
   * other rect in this file; the writer converts to Convention A through
   * toAnnotSpace. null means "use whatever the source page has".
   */
  cropBox: [number, number, number, number] | null
}

export type EditDocument = {
  version: number
  /**
   * One entry per opened file. A normal document has exactly one; merge
   * adds more. The hash guards replay against being handed the wrong bytes.
   */
  sources: Record<SourceId, { hash: string; name: string }>
  pageOrder: PageId[]
  pages: Record<PageId, PageEntry>
  objects: Record<ObjectId, EditObject>
  nextZ: number
}

export type Op =
  | { type: 'addObject'; object: EditObject }
  | { type: 'updateObject'; id: ObjectId; patch: Partial<EditObject> }
  | { type: 'deleteObject'; id: ObjectId }
  | { type: 'reorder'; id: ObjectId; z: number }
  // Task 42 -- page structure. These share the object ops' single linear
  // undo stack so Ctrl+Z is globally predictable (PLAN.md 1.2).
  | { type: 'rotatePage'; pageId: PageId; by: 90 | 180 | 270 }
  | { type: 'deletePages'; pageIds: PageId[] }
  | { type: 'reorderPages'; pageOrder: PageId[] }
  | { type: 'cropPage'; pageId: PageId; cropBox: Rect | null }
  /**
   * Insert pages, optionally registering the source they came from in the
   * same op. Folding registration in here rather than exposing a second
   * writer keeps `applyOp` the ONLY path that mutates an EditDocument, and
   * means undoing a merge removes the source entry along with its pages
   * instead of leaving an orphan behind.
   */
  | {
      type: 'insertPages'
      pages: Array<{ id: PageId } & PageEntry>
      at: number
      source?: { id: SourceId; hash: string; name: string }
    }

export const EDIT_DOCUMENT_VERSION = 2
