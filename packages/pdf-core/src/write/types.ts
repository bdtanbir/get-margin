import type { Rect } from '@margin/transform'

export type ObjectId = string
export type PageId = string

/**
 * Every kind of object that can be placed on a page.
 *
 * A runtime list, with the type derived from it, so the set can be
 * ENUMERATED rather than only checked. The viewer has one renderer per kind
 * and had silently gained kinds with no renderer at all -- an object that
 * exported correctly and drew nothing on screen. A list that exists only in
 * the type system cannot be iterated by the test that catches that.
 */
export const OBJECT_KINDS = [
  'text', 'image', 'rect', 'ellipse', 'line', 'arrow',
  'ink', 'highlight', 'underline', 'strikeout',
  'whiteout', 'link', 'signature',
  'field',
  'stamp',
  'redaction',
  'textPatch',
] as const

export type ObjectKind = (typeof OBJECT_KINDS)[number]

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
  /**
   * Draw in the family's weight-700 face.
   *
   * OPTIONAL, and absent means regular -- which is what every text object
   * written before this existed meant, so no stored document needs
   * migrating and no schema version had to move. Same reasoning as
   * `PageEntry.tabOrder`.
   *
   * A boolean rather than a numeric weight because two weights are what is
   * bundled (see apps/web/public/fonts/LICENSES.md). A `fontWeight: 500`
   * nobody has a file for would be a value the writer could only refuse.
   */
  bold?: boolean
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

/**
 * What a form field holds. `boolean` is the button types; `string[]` is a
 * multi-select list box.
 */
export type FieldValue = string | boolean | string[]

export type FieldType =
  | 'text' | 'checkbox' | 'radio' | 'dropdown' | 'listbox' | 'signature'

/**
 * A form field the USER created. Filling a field that already exists in the
 * source document is a different thing entirely and lives in
 * `EditDocument.fieldValues` -- see PHASE-5-DESIGN.md 0 for why the two are
 * not one type. In short: a field someone else authored is not the user's
 * to move, and materialising one object per field on open would defeat the
 * byte-identical pass-through before they had typed anything.
 */
export type FieldObject = BaseObject & {
  kind: 'field'
  fieldType: FieldType
  /** The field's /T. Unique per document, except across a radio group. */
  name: string
  /**
   * Radio only. Buttons sharing a group become kids of one parent field,
   * which is what makes them mutually exclusive.
   */
  group: string | null
  /**
   * Radio only, and load-bearing: this button's on-state name. It must be
   * unique within the group, because mupdf derives a kid's on-state from
   * the keys of its /AP /N dictionary and two kids sharing one are ONE
   * button as far as the format is concerned -- toggling either turns on
   * both, silently (docs/findings/12-phase-5-preflight.md 1).
   */
  exportValue: string | null
  value: FieldValue
  /** Choice types only, in the order they should appear. */
  options: string[]
  required: boolean
  readOnly: boolean
  multiline: boolean
  maxLength: number | null
  /** 0 means auto-size, which is what a /DA of "0 Tf" asks for. */
  fontSize: number
}

/**
 * A watermark, page number, header, footer, or Bates number.
 *
 * ONE kind for all five, because they differ in position, template, and
 * rotation -- not in how they are drawn. Five kinds would be five places to
 * fix the same bug, and the stamp dialog already distinguishes them.
 *
 * `text` is the RESOLVED string for this page, not the template: tokens are
 * substituted when the objects are generated, so replay is a pure function
 * of the edit document and does not need to know the page count.
 */
export type StampObject = BaseObject & {
  kind: 'stamp'
  /** Which preset produced this, for the inspector and for editing it later. */
  stampKind: 'watermark' | 'pageNumber' | 'header' | 'footer' | 'bates'
  /** The resolved text for THIS page. See resolveTokens for the template. */
  text: string
  fontFamily: string
  fontSize: number
  color: Color
  align: 'left' | 'center' | 'right'
  /**
   * Draw UNDER the page's existing content rather than over it. A watermark
   * over a photograph is unreadable; under it is invisible. Both are
   * wanted, so neither is a default the writer can pick.
   */
  behind: boolean
}

/**
 * Text the user wants GONE, not covered.
 *
 * Quads rather than a rect, in MuPDF page space, exactly like MarkupObject
 * -- and for the same reason: they come from buildQuadIndex, which produces
 * that space, and applyRedactions consumes /QuadPoints rather than /Rect.
 * The pre-flight redacted part of a word this way.
 *
 * The distinction from WhiteoutObject is the whole point and must never
 * blur: whiteout COVERS content and leaves it extractable, which
 * whiteout.test.ts asserts; this REMOVES it, which
 * redact-independent.test.ts verifies with two extractors that share no
 * code with MuPDF.
 */
export type RedactionObject = BaseObject & {
  kind: 'redaction'
  /** 8 numbers per quad, MuPDF page space. See MarkupObject. */
  quads: number[][]
  /**
   * Draw a black box where the text was.
   *
   * Removal happens either way -- this is only whether the file SHOWS that
   * it happened. Defaulting to false would make a redaction invisible to
   * the user and to whoever they send the file to, which for this feature
   * is the wrong kind of quiet.
   */
  blackBox: boolean
}

/**
 * A replacement for a line of the DOCUMENT's own text.
 *
 * The hardest thing in the product (PLAN.md 2.4), and the one whose
 * failure mode is worst: patching the wrong line damages a document while
 * reporting success. Hence `originalHash`.
 */
export type TextPatchObject = BaseObject & {
  kind: 'textPatch'
  /** Index of the line in the page's extraction, at edit time. */
  lineIndex: number
  /**
   * Hash of the line's text when the user edited it. THE GUARD: extraction
   * is not guaranteed stable across MuPDF versions or option changes, so a
   * mismatch means the text at this position is not what was edited, and
   * the export refuses rather than covering whatever is there now.
   */
  originalHash: string
  /** What it said, for the error message when the guard trips. */
  originalText: string
  text: string
  fontFamily: string
  /**
   * Draw the replacement in the bold face.
   *
   * Defaulted from the ORIGINAL line's own font when the patch is created:
   * MuPDF's extraction reports `isBold()` per glyph run, so replacing a
   * bold heading no longer quietly demotes it to regular. Still stored
   * rather than re-derived at export, because the user can override it and
   * an override has to survive.
   *
   * Optional for the same reason as TextObject.bold: absent means regular,
   * which is what every patch written before this meant.
   */
  bold?: boolean
  /** 0 means "derive from the line's height". */
  fontSize: number
  color: Color
  /**
   * The colour to cover the original with, sampled from the rendered page
   * at EDIT time -- the writer has no cheap way to render and sample, and
   * the app already has the pixels on screen.
   */
  background: Color
  /**
   * How confident the background sample was, 0..1. Low means the area was
   * varied -- a gradient, an image, a texture -- where a flat rectangle
   * will leave a visible scar. Stored so the UI can warn BEFORE the user
   * commits rather than after they export.
   */
  backgroundConfidence: number
  /** Wider replacement text: shrink to fit, let it run, or cut it short. */
  fit: 'shrink' | 'overflow' | 'truncate'
}

export type SignatureObject = BaseObject & {
  kind: 'signature'
  data: Uint8Array
  mime: 'image/png'
}

export type EditObject =
  | TextObject | ImageObject | ShapeObject | WhiteoutObject
  | InkObject | MarkupObject | LinkObject | SignatureObject | FieldObject
  | StampObject | RedactionObject | TextPatchObject

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
  /**
   * Form field names in tab order, for this page.
   *
   * OPTIONAL, and absent means document order -- which is what every
   * existing PDF already means, so a document that never touches tab order
   * is written exactly as it would have been. That is also why this needed
   * no schema version of its own.
   *
   * Names rather than object ids, because the same list has to address
   * fields the user created AND fields the source document already had, and
   * the name is the only identity those two share.
   */
  tabOrder?: string[]
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
  /**
   * Values for fields that ALREADY EXIST in a source document, keyed by
   * fully-qualified field name.
   *
   * Keyed by name rather than position because two widgets sharing a /T
   * are one field in PDF semantics and must hold the same value -- keying
   * by name makes that fall out instead of needing to be maintained. A
   * positional key would also break the moment a page was reordered or a
   * second document merged in.
   *
   * Fields with no /T -- structurally invalid, but real files contain
   * them -- are keyed `#unnamed:<pageId>#<index>`.
   */
  fieldValues: Record<string, FieldValue>
  /**
   * Flatten form fields into page content on export. One-way: the fields
   * are gone from the exported file. Off by default for that reason.
   */
  flattenForms: boolean
  /**
   * The document description, or undefined to leave the source's alone.
   *
   * Unlike a password this IS safe to autosave: a title and author are
   * document content, not a secret, and losing them on reload would be a
   * worse trade than storing them.
   */
  metadata?: {
    title: string
    author: string
    subject: string
    keywords: string
    creator: string
  }
  /** Remove all metadata on export. Takes precedence over `metadata`. */
  stripMetadata?: boolean
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
  /**
   * Task 71 -- fill a field the SOURCE document already had.
   *
   * Not an object op, because a field someone else authored is not an
   * object: it has no rect of the user's choosing, no z, and nothing to
   * drag. See PHASE-5-DESIGN.md 0.
   */
  | { type: 'setFieldValue'; key: string; value: FieldValue }
  /** Task 72 -- flatten form fields into page content on export. */
  | { type: 'setFlattenForms'; on: boolean }
  /** Task 76 -- field names in tab order for one page. */
  | { type: 'setTabOrder'; pageId: PageId; order: string[] }
  /** Task 86 -- the document description. */
  | { type: 'setMetadata'; metadata: EditDocument['metadata'] }
  | { type: 'setStripMetadata'; strip: boolean }

export const EDIT_DOCUMENT_VERSION = 3

/**
 * An edit document describing no edits at all.
 *
 * Exists so that adding a member to EditDocument does not break every
 * caller that had to spell one out. The v2 bump broke five; this is the
 * seam that makes the next bump break none. Callers needing a populated
 * document spread over it.
 */
export function emptyEditDocument(): EditDocument {
  return {
    version: EDIT_DOCUMENT_VERSION,
    sources: {},
    pageOrder: [],
    pages: {},
    objects: {},
    nextZ: 1,
    fieldValues: {},
    flattenForms: false,
  }
}
