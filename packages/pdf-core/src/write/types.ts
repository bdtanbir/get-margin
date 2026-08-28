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
  'imagePatch',
  'regionPatch',
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
  /**
   * Draw in the family's italic face.
   *
   * Optional and absent means upright, for the same reason as `bold`: no
   * stored document needs migrating and no schema version moves. The two
   * combine -- bold italic is a fourth FILE, not a bold file drawn on a
   * slant.
   */
  italic?: boolean
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
  /**
   * Draw the replacement on a slant, defaulted from the original line the
   * same way `bold` is -- MuPDF reports `isItalic()` per run, verified
   * against embedded TrueType and not only the standard 14.
   */
  italic?: boolean
  /**
   * The size to set the replacement in.
   *
   * 0 means "whatever the original line was set in", resolved by the writer
   * from its own re-extraction. That is what every patch written before the
   * size was editable contains, and it stays valid -- but a patch made now
   * carries the real number instead, so the inspector has something to show
   * in its box rather than a zero the reader has to know the meaning of.
   */
  fontSize: number
  /**
   * Where the pen sat on the original line, in MuPDF PAGE space -- the same
   * space `rect` uses for this kind. See `LineRun.baseline`.
   *
   * FOR THE PREVIEW ONLY. The writer re-derives this at export from the
   * assembled page, which is authoritative and can differ if the page moved;
   * this is the app's copy so the overlay can draw the replacement where the
   * export will put it.
   *
   * It exists because the alternative was deriving a baseline from the box
   * and the font size, and that derivation is wrong by however much the
   * font's descender differs from the constant -- about 5pt on a 24pt line
   * in the test fixture. Harmless while the size was fixed, because the
   * error was fixed too. The moment the size became editable the error
   * became a function of it, and the previewed text would slide up the page
   * as you increased the size while the exported text stayed put.
   */
  baseline?: number
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
  /**
   * How far the replacement is drawn FROM the line it replaces, in points,
   * MuPDF page space -- top-down, the same space `rect` and `baseline` use
   * for this kind. Positive dy is down the page.
   *
   * A relative offset rather than a destination rect, and that is the whole
   * design. The writer does not read this object's geometry: it re-extracts
   * the line from the assembled page at export, because the hash guard is
   * only meaningful against what is actually there. A stored destination
   * would be a second source of truth that could disagree with that
   * re-extraction; an offset composes with whatever it finds.
   *
   * Only the TEXT moves. The cover stays over the original line, because
   * the document's own glyphs are still underneath it -- see
   * `write/objects/patch.ts`. Moving both would be a no-op and moving
   * neither would be a copy.
   *
   * Optional, and absent means 0,0 -- which is what every patch written
   * before this meant, so no stored document needs migrating and the schema
   * version did not have to move. Same reasoning as `bold` above and
   * `PageEntry.tabOrder`.
   */
  offset?: { dx: number; dy: number }
}

/**
 * A patch over one of the DOCUMENT'S OWN images.
 *
 * Cover and redraw, exactly as `TextPatchObject` is, and deliberately the
 * same shape: an opaque rectangle in the sampled background colour over
 * where the image is, and -- if it is being moved rather than deleted --
 * a copy of it drawn somewhere else.
 *
 * ONE KIND FOR BOTH, with `data` absent meaning "deleted". Two kinds would
 * put two rows in the layers list for what the user did once, and would
 * make "delete a moved image" a conversion between kinds rather than the
 * removal of a field.
 *
 * IT COVERS; IT DOES NOT REMOVE. The image stream stays in the file and
 * stays extractable, like every whiteout and every text patch. That is a
 * specification (imagePatch.test.ts pins it), not an oversight -- removal
 * is redaction's job and carries a guarantee this cannot make.
 */
export type ImagePatchObject = BaseObject & {
  kind: 'imagePatch'
  /**
   * Which image on the page, in DRAW ORDER -- see `ImagePlacement.index`.
   *
   * A position, not an identity, which is exactly why `originalHash` has
   * to exist alongside it.
   */
  imageIndex: number
  /**
   * The placement's identity when the user edited it, from
   * `placementHash`. The writer re-walks the assembled page at export and
   * REFUSES if the image at `imageIndex` no longer hashes the same.
   *
   * `PLAN.md` 2.4: fail loudly, never silently mispatch. Covering
   * whatever happens to sit at that index now would damage a document
   * while reporting success.
   */
  originalHash: string
  /**
   * The colour to cover the original with, sampled from the rendered page
   * at EDIT time -- the writer has no cheap way to render and sample, and
   * the app already has the pixels on screen. Same bargain as
   * `TextPatchObject.background`.
   */
  background: Color
  /**
   * How confident that sample was, 0..1. Low means the area behind the
   * image was varied, where a flat rectangle leaves a visible scar -- so
   * the UI can warn BEFORE the user commits.
   */
  backgroundConfidence: number
  /**
   * The image to REDRAW, as a raster of what the page actually shows.
   *
   * Absent means deleted: cover, and draw nothing.
   *
   * A raster rather than a reference to the document's own XObject, and
   * that is a measured decision rather than a shortcut. Probing a real
   * e-ticket found its images nested inside form XObjects rather than in
   * the page's resources, drawn through a `clipImageMask` stencil that
   * carries the transparency the image itself does not, in one case in an
   * Indexed CMYK space that `compress.ts` already documents as failing to
   * round-trip. Re-referencing the original would have to solve all three
   * to put the logo down again without a black box behind it. Asking the
   * renderer for the pixels a reader would see solves none of them and
   * needs to.
   */
  data?: Uint8Array
  mime?: 'image/png'
  /**
   * The size the copy is DRAWN at, in points. Absent means "the size of
   * what it covers", which is what every patch written before this meant.
   *
   * Separate from `rect` because the two answer different questions and
   * must be free to disagree. `rect` is the area being covered and has to
   * stay exactly over the page's own content, or that content reappears
   * from under its own cover; the copy is a picture and can be any size
   * the user drags it to.
   *
   * It pairs with `offset`, which positions the copy's TOP-LEFT corner --
   * so a resize that drags a north or west handle changes both, and one
   * that drags a south or east handle changes only this.
   */
  size?: { w: number; h: number }
  /**
   * How far the redrawn copy sits FROM the image it replaces, in points,
   * MuPDF page space -- top-down, the same space `rect` uses for this
   * kind. Positive dy is down the page.
   *
   * Relative rather than absolute for the same reason `TextPatchObject`
   * is: the writer does not read this object's geometry, it re-walks the
   * page at export so the hash guard is meaningful, and a stored
   * destination would be a second source of truth that could disagree
   * with what it finds.
   *
   * Only the COPY moves. The cover stays over the original, because the
   * document's own image is still underneath it.
   */
  offset?: { dx: number; dy: number }
}

/**
 * A patch over an area of the page the USER drew a box around.
 *
 * The escape hatch from `ImagePatchObject`. A great deal of what a reader
 * calls "the logo" is not an image: page 2 of a real US-Bangla e-ticket
 * draws the same logo page 1 embeds as a raster using 21 vector paths, so
 * no image index can reach it. Rather than guess which paths belong
 * together -- a heuristic that eventually takes the rule beside them --
 * this lets the boundary be drawn.
 *
 * Same fields as an image patch minus the address, because a region needs
 * none: `rect` IS the address. That is also why there is no hash guard.
 *
 * IT COVERS; IT DOES NOT REMOVE, like every other patch and every
 * whiteout.
 */
export type RegionPatchObject = BaseObject & {
  kind: 'regionPatch'
  /**
   * The colour to cover the area with, sampled from the rendered page at
   * EDIT time -- the writer has no cheap way to render and sample, and the
   * app already has the pixels on screen.
   */
  background: Color
  /** How confident that sample was, 0..1. See `ImagePatchObject`. */
  backgroundConfidence: number
  /**
   * The area to REDRAW, as a raster of what the page shows there.
   *
   * Absent means hidden: cover, and draw nothing.
   *
   * A raster is not a compromise here the way it is for an image patch --
   * it is the only possible answer. The area may hold vector paths, text,
   * an image, or all three at once, and the one thing they have in common
   * is what they look like.
   */
  data?: Uint8Array
  mime?: 'image/png'
  /** The size the copy is drawn at. See `ImagePatchObject.size`. */
  size?: { w: number; h: number }
  /**
   * How far the copy sits FROM the area it was lifted out of, in points,
   * MuPDF page space -- top-down, the same space `rect` uses for this
   * kind. Positive dy is down the page.
   *
   * Only the COPY moves. The cover stays over the original, because the
   * page's own content is still underneath it.
   */
  offset?: { dx: number; dy: number }
}

export type SignatureObject = BaseObject & {
  kind: 'signature'
  data: Uint8Array
  mime: 'image/png'
}

export type EditObject =
  | TextObject | ImageObject | ShapeObject | WhiteoutObject
  | InkObject | MarkupObject | LinkObject | SignatureObject | FieldObject
  | StampObject | RedactionObject | TextPatchObject | ImagePatchObject | RegionPatchObject

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
