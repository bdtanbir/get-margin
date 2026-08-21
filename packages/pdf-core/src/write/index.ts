import * as mupdf from 'mupdf'
import { withPage, SAVE_OPTIONS } from './session.js'
import { assemble, isUntouched, type SourceBytes, type SourcePasswords } from './assemble.js'
import { applyPageBoxes, applyTabOrder } from './objects/page.js'
import { geometryFromPageObject } from '../geometry.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument, type EditObject, type ObjectKind } from './types.js'
import type { PageGeometry } from '@margin/transform'
import { writeShape } from './objects/shape.js'
import { writeWhiteout } from './objects/whiteout.js'
import { writeText } from './objects/text.js'
import { FontRegistry, createMeasurer, type FontProvider } from './fonts.js'
import { writeImage } from './objects/image.js'
import { createXObjectCache, type XObjectCache } from './xobject.js'
import { writeInk } from './objects/ink.js'
import { writeLink } from './objects/link.js'
import { writeMarkup } from './objects/markup.js'
import { writeField } from './objects/field.js'
import { writeStamp } from './objects/stamp.js'
import { writeTextPatch } from './objects/patch.js'
export { onAppearance, offAppearance, twoStateAppearance } from './fieldAppearance.js'
export { listFields, fieldKey, applyFieldValues, hasAcroForm } from './fields.js'
export {
  readMetadata, writeMetadata, stripMetadata, buildXmp, EMPTY_METADATA,
  type DocumentMetadata,
} from './metadata.js'
export {
  recompressImages, PRESETS as COMPRESSION_PRESETS,
  type CompressionPreset, type CompressionResult,
} from './compress.js'
export type { SourceField, SourceFieldType } from './fields.js'
import { migrateEditDocument } from './migrate.js'
import { stripActiveContent, anythingStripped, type StrippedContent } from './sanitize.js'
import { applyFieldValues } from './fields.js'
import { applyRedactions } from './objects/redact.js'
import { protectedSave, type Protection } from './protect.js'
import { writeMetadata, stripMetadata } from './metadata.js'

export type WriteContext = {
  raw: mupdf.PDFDocument
  page: mupdf.PDFPage
  geometry: PageGeometry
  /**
   * Task 31 widened this context. Both members are always present -- a
   * document with no text objects simply never touches them -- so every
   * writer written before Task 31 stays valid unchanged.
   */
  fonts: FontRegistry
  /**
   * Advance width of `text` in points. See createMeasurer in fonts.ts.
   *
   * `face` is a `faceKey(family, bold)`, NOT a bare family -- bold glyphs
   * are wider, and measuring them against the regular silently mis-places
   * every centred and right-aligned line.
   */
  measure: (text: string, face: string, size: number) => number
  /**
   * Task 32, the third and final widening. Embed-once memo for image
   * XObjects, keyed by payload -- see xobject.ts.
   */
  xobject: XObjectCache
}

export type ObjectWriter = (ctx: WriteContext, object: EditObject) => void

/**
 * One writer per ObjectKind. Tasks 29-35 and 38 each register their kind
 * here; this map is deliberately the ONLY place a kind becomes a drawing
 * operation, so an unhandled kind is a loud startup-time gap rather than a
 * silently-dropped object in someone's exported document.
 */
export const WRITERS: Partial<Record<ObjectKind, ObjectWriter>> = {}

// Task 29. All four shapes share one writer -- they differ only in the path
// they emit, not in how colour, opacity, or the painting operator are
// resolved.
WRITERS.rect = writeShape
WRITERS.ellipse = writeShape
WRITERS.line = writeShape
WRITERS.arrow = writeShape

// Task 30. Covers content; does not remove it -- see objects/whiteout.ts.
WRITERS.whiteout = writeWhiteout

// Task 31. Content-stream operators, NOT a FreeText annotation: Phase 0
// measured that FreeText silently ignores any font outside the standard 14,
// and every bundled face is non-base-14.
WRITERS.text = writeText

// Task 32. Drawn as an XObject in the content stream, not an annotation:
// an image is page content, and content is what survives flattening.
WRITERS.image = writeImage

// Task 33. A NATIVE Ink annotation, not content-stream paths: ink stays
// selectable and removable in other PDF tools (the semantic split, spec 0).
WRITERS.ink = writeInk

// Task 34. page.createLink (fz_link), NOT createAnnotation('Link') -- see
// objects/link.ts for what Phase 0 measured about the difference.
WRITERS.link = writeLink

// Task 35. A signature is a raster placed on the page, so it exports through
// the SAME writer as an image rather than a near-copy of it -- the two differ
// only in provenance and in which inspector fields they offer. Sharing the
// writer also means they share the embed-once XObject cache, so one signature
// applied to every page of a contract embeds once.
WRITERS.signature = writeImage

// Task 38. Native /QuadPoints annotations -- they stay editable and
// removable in other PDF tools and do not damage the page.
// Task 67. Form fields the USER created -- filling a field that already
// exists in the source is not an object and does not come through here.
WRITERS.field = writeField

// Task 79. Watermarks, page numbers, headers, footers, and Bates numbers
// are CONTENT, not annotations -- the deliberate opposite of the ink and
// markup writers above. A watermark a reader can select and delete is not a
// watermark.
WRITERS.stamp = writeStamp

// Task 91. Cover-and-redraw over the document's own text. Refuses rather
// than mispatching -- see objects/patch.ts.
WRITERS.textPatch = writeTextPatch

WRITERS.highlight = writeMarkup
WRITERS.underline = writeMarkup
WRITERS.strikeout = writeMarkup

/**
 * Build the exported document.
 *
 * A pure function of its inputs: it opens a SECOND document from the
 * pristine source bytes and never touches the one being rendered, which is
 * what keeps spec 1.5's deferred-bake invariant true. Runs entirely in the
 * worker, and is fully testable in Node with no browser.
 */
export type ReplayOptions = {
  /**
   * Font bytes by family name, for text objects. Optional: a document with
   * no text needs none, and resolving one that was never supplied throws by
   * name rather than substituting a face silently (see FontRegistry).
   */
  fonts?: FontProvider
  /**
   * Called after each page is written, with the number of pages done and
   * the total that will be visited.
   *
   * NO YIELDING between pages, deliberately. The plan called for it so
   * progress would paint, on the assumption that a busy worker blocks its
   * own updates -- it does not: a worker's postMessage is queued to the MAIN
   * thread's event loop, which is idle and paints normally while WASM churns
   * here. Yielding would mean making this function async, and an async
   * export is one an edit could interleave with.
   */
  onProgress?: (done: number, total: number) => void
  /**
   * Called once per export with what active content was removed, so the UI
   * can say so. Stripping happens whether or not this is supplied.
   */
  onStripped?: (found: StrippedContent) => void
  /**
   * Encrypt the exported file.
   *
   * Passed per call rather than stored on the EditDocument, because a
   * password is a secret and the EditDocument is what autosave writes to
   * IndexedDB. Keeping it here means the setting is lost on reload, which
   * is the right trade against writing someone's password to disk.
   */
  protection?: Protection
  /**
   * Save the export with NO encryption, dropping whatever the source had.
   *
   * Needed because MuPDF's save default is `encrypt=keep`: an edited
   * export of a protected document comes back still protected, which is a
   * sensible default and leaves no way to say otherwise. Mutually
   * exclusive with `protection`, which sets a new password instead.
   */
  removeProtection?: boolean
  /**
   * Passwords for sources that need one.
   *
   * Without these an encrypted source opens but cannot be DECRYPTED, and
   * the export comes out with pages and no content -- see assemble.ts.
   */
  passwords?: SourcePasswords
  /**
   * The value written as /ModDate and XMP xmp:ModifyDate.
   *
   * Passed in rather than read from the clock, because replay must be a
   * pure function of its inputs: a writer that stamped `new Date()` would
   * make two exports of the same document differ, which would break the
   * byte-identical guarantees the rest of this file works to keep.
   */
  modified?: string
}

export function replay(
  sources: SourceBytes,
  input: EditDocument,
  opts: ReplayOptions = {},
): Uint8Array {
  // Lift an older schema before touching anything. This also performs the
  // "newer than this build" check, so there is exactly one place that
  // decides what versions mean.
  //
  // Not decoration: a v1 document reaching here untouched has no `sources`
  // map, and the first thing that reads it fails with "Cannot convert
  // undefined or null to object" -- an error naming nothing the user or a
  // developer could act on.
  const editDoc = migrateEditDocument(input)

  const provider: FontProvider = opts.fonts ?? new Map()
  const measure = createMeasurer(provider)
  const hasObjects = Object.keys(editDoc.objects).length > 0
  // A filled field and a flatten request are edits as much as an object is.
  // Without this a user could type into a form, hit Download, and get their
  // original file back -- the pass-through tier silently discarding the
  // only thing they did.
  const hasFills = Object.keys(editDoc.fieldValues ?? {}).length > 0
  const flatten = editDoc.flattenForms === true
  const hasTabOrder = editDoc.pageOrder.some(
    (id) => (editDoc.pages[id]?.tabOrder?.length ?? 0) > 0,
  )
  // Protecting an otherwise-untouched document is an edit to its bytes,
  // even though it is not an edit to its content. Without this the
  // pass-through would hand back the original, unencrypted, having been
  // asked for a password.
  const protection = opts.protection
  // Removing a password changes the file even when nothing else did, so
  // the pass-through must not hand back the encrypted original.
  const unprotect = opts.removeProtection === true && !protection
  // Describing the document differently is an edit to it, so an otherwise
  // untouched file must not come back through the pass-through unchanged.
  const hasMetadata = editDoc.stripMetadata === true || editDoc.metadata !== undefined

  // See assemble(). Pages come back already in pageOrder, so from here on a
  // page is addressed by its POSITION, not its sourceIndex.
  const { raw, unchanged } = assemble(sources, editDoc, opts.passwords)
  try {
    // BEFORE the pass-through decision, not after: an unedited hostile file
    // would otherwise be handed straight back with its scripts intact.
    const stripped = stripActiveContent(raw)
    opts.onStripped?.(stripped)

    // TIER 1. The edit describes exactly the file that was opened, adds
    // nothing to it, and nothing had to be removed from it -- so hand back
    // the user's own bytes rather than a re-serialisation.
    // e2e/download.spec.ts asserts this byte-for-byte.
    if (
      unchanged && !hasObjects && !hasFills && !flatten && !hasTabOrder && !protection
      && !unprotect && !hasMetadata && !anythingStripped(stripped)
    ) {
      const original = sources.get(Object.keys(editDoc.sources)[0]!)
      if (original) return original
    }

    // Read geometry off the assembled document, so a page that was rotated
    // or cropped by an earlier op is measured as it now is.
    const geometryOf = (index: number): PageGeometry =>
      withPage(raw, index, (page) => geometryFromPageObject(page.getObject()))

    // Page boxes BEFORE objects: an object's rect is raw PDF user space and
    // a crop only changes the window, but the geometry the writers receive
    // must be the final one.
    applyPageBoxes(raw, editDoc, geometryOf)

    // One registry per replay call, so a family used on five pages is parsed
    // and embedded once rather than five times.
    const fonts = new FontRegistry(raw, provider)
    // Per document, not per page: the SAME image placed on ten pages is one
    // embedded stream referenced ten times.
    const xobject = createXObjectCache()

    // Group objects by page once, then draw each page's objects in z order.
    // Sorting per page rather than globally keeps stacking well-defined
    // within a page without imposing a meaningless order across pages.
    const byPage = new Map<string, EditObject[]>()
    for (const object of Object.values(editDoc.objects)) {
      // Redactions are not a drawing operation and deliberately have no
      // entry in WRITERS -- applyRedactions handles a whole page at once,
      // after this loop. Registering a no-op writer for them would weaken
      // the "unhandled kind fails the export" guarantee below into
      // "unhandled kind might be intentional".
      if (object.kind === 'redaction') continue
      const list = byPage.get(object.pageId)
      if (list) list.push(object)
      else byPage.set(object.pageId, [object])
    }

    // Only pages carrying objects are visited, so that is what progress is
    // measured against -- reporting against the document's full page count
    // would show a bar that jumps to 100% and sits there.
    const pagesToWrite = editDoc.pageOrder
      .map((pageId, index) => ({ pageId, index }))
      .filter(({ pageId }) => (byPage.get(pageId)?.length ?? 0) > 0)
    let done = 0

    for (const { pageId, index } of pagesToWrite) {
      const objects = byPage.get(pageId)
      if (!objects || objects.length === 0) continue

      objects.sort((a, b) => a.z - b.z)
      const geometry = geometryOf(index)

      withPage(raw, index, (page) => {
        for (const object of objects) {
          const writer = WRITERS[object.kind]
          if (!writer) {
            // Fail the WHOLE export. A partial PDF that silently dropped a
            // signature is worse than a failed download, because the user
            // will not notice the omission.
            throw new Error(
              `no writer registered for object kind "${object.kind}" (object ${object.id})`,
            )
          }
          try {
            writer({ raw, page, geometry, fonts, measure, xobject }, object)
          } catch (cause) {
            // Name the object and the page. "Could not export this PDF" tells
            // the user nothing they can act on; "the signature on page 3"
            // tells them exactly which edit to remove and retry.
            const reason = cause instanceof Error ? cause.message : String(cause)
            throw new Error(
              `Could not export the ${object.kind} on page ${index + 1}: ${reason}`,
              { cause },
            )
          }
        }
      })

      done++
      opts.onProgress?.(done, pagesToWrite.length)
    }

    // AFTER the object writers: a field created in this same session has to
    // exist before a value can be set on it.
    if (hasFills) {
      applyFieldValues(
        raw,
        editDoc.fieldValues,
        editDoc.pageOrder.map((pageId) => {
          const entry = editDoc.pages[pageId]
          return entry ? `${entry.sourceId}:${entry.sourceIndex}` : ''
        }),
      )
    }

    // AFTER the ordinary writers: a redaction removes what the SOURCE
    // document said, not what the user drew on top of it a moment ago. And
    // before flatten, so a redacted form field is redacted before it is
    // frozen into the page.
    applyRedactions(raw, editDoc)

    // AFTER the fields exist and BEFORE they are baked: tab order IS
    // /Annots order, so it has to be applied while there is still an
    // /Annots array of widgets to order.
    applyTabOrder(raw, editDoc)

    // Metadata before flatten and protection: both rewrite the document in
    // ways that make later edits to the catalog awkward, and neither needs
    // to see the description.
    if (editDoc.stripMetadata) {
      stripMetadata(raw)
    } else if (editDoc.metadata) {
      writeMetadata(raw, editDoc.metadata, opts.modified ?? 'D:20000101000000Z')
    }

    // LAST, and on the assembled export copy only. bake() draws each
    // field's appearance into the page content and removes /AcroForm
    // wholesale -- it is not undoable, and doing it to the document being
    // edited would destroy the user's form rather than their copy of it.
    if (flatten) raw.bake(false, true)

    // protectedSave verifies its own output rather than trusting a call
    // that did not throw -- see protect.ts for the three silent ways a
    // "protected" save produces an unprotected file.
    if (protection) return protectedSave(raw, protection, SAVE_OPTIONS)

    // encrypt=none is NOT redundant. The default is encrypt=keep, so
    // saving a document opened from encrypted bytes preserves the
    // encryption -- and the caller asked for the opposite.
    if (unprotect) return raw.saveToBuffer(`${SAVE_OPTIONS},encrypt=none`).asUint8Array()

    return raw.saveToBuffer(SAVE_OPTIONS).asUint8Array()
  } finally {
    // Disposal is a correctness requirement: omitting it hard-crashes the
    // WASM heap rather than leaking gradually.
    raw.destroy()
  }
}

export { withDocument, withPage, SAVE_OPTIONS } from './session.js'
export { assemble, isUntouched, type SourceBytes, type SourcePasswords } from './assemble.js'
export { applyPageBoxes, applyTabOrder } from './objects/page.js'
export { applyRedactions } from './objects/redact.js'
export {
  stripActiveContent, anythingStripped, nothingStripped, type StrippedContent,
} from './sanitize.js'
export {
  protectedSave, removeProtection, unlock, permissionMask, grantedPermissions,
  ProtectionFailed, PERMISSION_BITS,
  type Protection, type PermissionName,
} from './protect.js'
export { toAnnotSpace, toContentSpace, num } from './coords.js'
export {
  appendContent, prependContent, addResource, fillColor, strokeColor, alphaState,
} from './content.js'
export { writeShape } from './objects/shape.js'
export { writeWhiteout } from './objects/whiteout.js'
export { writeText, ASCENT_RATIO, LINE_HEIGHT } from './objects/text.js'
export { FontRegistry, createMeasurer, pdfString, type FontProvider } from './fonts.js'
export { writeImage } from './objects/image.js'
export { createXObjectCache, type XObjectCache } from './xobject.js'
export { writeInk } from './objects/ink.js'
export { writeLink } from './objects/link.js'
export { writeMarkup } from './objects/markup.js'
export { writeStamp, resolveTokens, batesNumber, type StampContext } from './objects/stamp.js'
export {
  writeTextPatch, hashText, missingGlyphs, missingGlyphsFor, PatchRefused,
} from './objects/patch.js'
export {
  writeField, ensureAcroForm, pageAnnots, commonFlags, newWidget,
  FIELD_READ_ONLY, FIELD_REQUIRED, TX_MULTILINE, BTN_NO_TOGGLE_OFF, BTN_RADIO, CH_COMBO,
} from './objects/field.js'
export { migrateEditDocument, LEGACY_SOURCE_ID } from './migrate.js'
