export { PdfDocument, PdfOpenError, looksLikePdf } from './engine.js'
export { geometryFromPageObject } from './geometry.js'
export type { RawObj } from './geometry.js'
export { renderPage, MUPDF_APPLIES_ROTATION } from './render.js'
export type { RenderedPage } from './render.js'
export type {
  ObjectId, PageId, SourceId, PageEntry,
  ObjectKind, Color, EditObject, EditDocument, Op,
  TextObject, ImageObject, ShapeObject, WhiteoutObject,
  InkObject, MarkupObject, LinkObject, SignatureObject,
} from './write/types.js'
export { EDIT_DOCUMENT_VERSION } from './write/types.js'
export { migrateEditDocument, LEGACY_SOURCE_ID } from './write/migrate.js'
export { replay, WRITERS, type ObjectWriter, type WriteContext } from './write/index.js'
export {
  stripActiveContent, anythingStripped, nothingStripped, type StrippedContent,
} from './write/sanitize.js'

// Task 36. Per-page text geometry for selection, in MuPDF page space.
export { buildQuadIndex } from './text/index.js'
export type { Quad, CharQuad, LineRun, PageQuadIndex } from './text/index.js'
