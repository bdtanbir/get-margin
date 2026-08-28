import {
  PdfDocument, renderPage, rasterisePage, rasterSize, replay, buildQuadIndex, buildImageIndex,
  cropImage, cropRegion,
  listFields,
  readMetadata, recompressImages,
  findInPage, missingGlyphsFor,
  type EditDocument, type PageQuadIndex, type PageImageIndex, type SourceId,
  type StrippedContent,
  type SourceField, type Protection, type DocumentMetadata,
  type CompressionPreset, type CompressionResult, type FindOptions, type Match,
  type RasterFormat, type RasterisedPage,
} from '@margin/pdf-core'
import type { PageGeometry } from '@margin/transform'

export type DocumentInfo = {
  pageCount: number
  geometries: PageGeometry[]
  needsPassword: boolean
  /**
   * The id the worker filed this file's bytes under. The main thread stores
   * it on the page entries rather than minting its own, so both sides agree
   * on which bytes a page came from -- which is what merge needs.
   */
  sourceId: SourceId
}

export type RenderRequest = { id: number; page: number; scale: number; sourceId?: SourceId }
export type RenderResult = { width: number; height: number; rgba: Uint8Array; page: number; scale: number }

/**
 * All PDF work for the app, with no knowledge of workers or Comlink.
 * Instantiated once inside pdf.worker.ts; unit-tested directly in Node.
 *
 * MuPDF is not safely reentrant, so callers must serialize: the worker's
 * single-threaded event loop provides that, and pdfClient never issues
 * overlapping render calls.
 */
export class PdfService {
  #doc: PdfDocument | undefined
  /**
   * A pristine copy of the file the user opened, retained for the whole
   * lifetime of the open document.
   *
   * This is what makes export a pure function of (sourceBytes, EditDocument):
   * `replay()` (Task 24) builds a SECOND document from these bytes and never
   * touches `#doc`, which is what keeps spec §1.5's deferred-bake invariant
   * true — an edit never invalidates a page bitmap, because the document
   * being rendered is never modified.
   *
   * Costs one extra resident copy of the file. `bytes` was transferred into
   * this worker by pdfClient, so retaining the reference is free; it is not
   * a second copy of anything the main thread still holds.
   */
  #sources = new Map<SourceId, Uint8Array>()
  #nextSourceId = 0

  /** The id of the file the user opened first, and the one `#doc` renders. */
  #primarySource: SourceId | undefined

  /** One extra open handle, for rendering pages merged in from another file. */
  #secondary: PdfDocument | undefined
  #secondaryId: SourceId | undefined

  /**
   * Per-page text geometry, cached for the life of the open document.
   *
   * Extraction walks every glyph on the page, so re-running it as the user
   * scrolls back and forth would be the dominant cost of text selection.
   * The source document is never mutated (see #sourceBytes), so a page's
   * quads cannot go stale while it is open; close() drops the cache with
   * everything else.
   */
  // Keyed `sourceId:page`, not by page alone: two merged files both have a
  // page 0, and sharing one entry served the wrong file's text.
  #quadCache = new Map<string, PageQuadIndex>()
  #imageCache = new Map<string, PageImageIndex>()

  #info(): DocumentInfo {
    const doc = this.#doc
    if (!doc) throw new Error('no document open')
    const needsPassword = doc.needsPassword()
    // Geometry is unavailable until authentication succeeds.
    const geometries = needsPassword
      ? []
      : Array.from({ length: doc.pageCount }, (_, i) => doc.pageGeometry(i))
    return {
      pageCount: needsPassword ? 0 : doc.pageCount,
      geometries,
      needsPassword,
      sourceId: this.#primarySource ?? '',
    }
  }

  /**
   * Opens a new document, closing whatever was previously open.
   *
   * `bytes` is transferred (not copied) across the worker boundary by
   * pdfClient, which neuters the caller's ArrayBuffer — the main thread
   * must not read `bytes` again after this call resolves. Callers that need
   * the file's name, size, or hash must capture those before calling.
   */
  open(bytes: Uint8Array): DocumentInfo {
    this.close()
    const sourceId = this.#register(bytes)
    this.#primarySource = sourceId
    this.#doc = PdfDocument.open(bytes)
    return this.#info()
  }

  /** File bytes under a fresh id, retained for the document's lifetime. */
  #register(bytes: Uint8Array): SourceId {
    const id: SourceId = `src-${this.#nextSourceId++}`
    this.#sources.set(id, bytes)
    return id
  }

  /**
   * Register another file for merging, and report its geometry so the main
   * thread can seed page entries without reopening the file there.
   *
   * The bytes are RETAINED for as long as the document is open: several
   * large files resident at once is this feature's memory ceiling.
   *
   * `dropSource` is NOT called automatically, and that is deliberate.
   * Adding a file is an undoable `insertPages` op, so undo removes its
   * pages and REDO brings them back -- freeing the bytes in between would
   * leave a redo that cannot render or export. Everything is released when
   * the document is closed. An explicit "remove this file" action could
   * drop them sooner, but it would have to discard that source's history
   * too; see docs/findings/08-phase-3-verification.md.
   */
  addSource(bytes: Uint8Array): { sourceId: SourceId; pageCount: number; geometries: PageGeometry[] } {
    const doc = PdfDocument.open(bytes)
    try {
      const geometries = Array.from({ length: doc.pageCount }, (_, i) => doc.pageGeometry(i))
      return { sourceId: this.#register(bytes), pageCount: doc.pageCount, geometries }
    } finally {
      doc.close()
    }
  }

  /**
   * Forget a source's bytes.
   *
   * Not wired to anything yet -- see addSource for why an automatic drop is
   * unsafe while undo/redo can bring a source's pages back. Kept because
   * close() and any future explicit "remove file" action need it.
   */
  dropSource(id: SourceId): void {
    if (id === this.#primarySource) return
    this.#sources.delete(id)
    if (this.#secondaryId === id) {
      this.#secondary?.close()
      this.#secondary = undefined
      this.#secondaryId = undefined
    }
  }

  sourceIds(): SourceId[] {
    return [...this.#sources.keys()]
  }

  /** Total retained source bytes, so the main thread can bound a merge. */
  openBytes(): number {
    let total = 0
    for (const bytes of this.#sources.values()) total += bytes.byteLength
    return total
  }

  /**
   * Passwords for sources that needed one, in memory only.
   *
   * The decrypted document is already in this worker's memory, so holding
   * the password alongside it for the session costs no additional
   * exposure -- and without it every export of a protected document comes
   * out blank (see assemble.ts). Never persisted, and cleared with the
   * document.
   */
  #passwords = new Map<SourceId, string>()

  authenticate(password: string): DocumentInfo {
    const doc = this.#doc
    if (!doc) throw new Error('no document open')
    if (!doc.authenticate(password)) throw new Error('Incorrect password')
    // Kept so the EXPORT can decrypt this source. Without it every edited
    // export of this document comes out with pages and no content.
    if (this.#primarySource) this.#passwords.set(this.#primarySource, password)
    return this.#info()
  }

  /**
   * Renders one page. There is no cancellation here — see the long comment
   * on `PdfClient.render` in pdfClient.ts for why a per-request cancel
   * message cannot work over Comlink's synchronous, FIFO message channel.
   * The real abandonment mechanism is one layer up, in the viewport store's
   * `pump()`, which re-plans between renders instead of mid-render (MuPDF
   * cannot be interrupted once inside WASM, so between-renders is the
   * finest granularity available).
   */
  render(req: RenderRequest): RenderResult | null {
    const doc = this.#docFor(req.sourceId)
    if (!doc) throw new Error('no document open')
    const { width, height, rgba } = renderPage(doc, req.page, req.scale)
    return { width, height, rgba, page: req.page, scale: req.scale }
  }

  /**
   * The open handle for a source, opening it if this is the first page from
   * that file to be rendered.
   *
   * A HANDLE is the expensive resource here, not the bytes: parsing keeps a
   * page tree and object cache alive. Only the primary document and the
   * most recently used secondary are kept open, so scrolling through a
   * merge of two files costs two handles rather than one per source. A grid
   * spanning many files will reopen as it scrolls; that is a measured
   * trade-off to revisit if merges get wide, not an oversight.
   */
  #docFor(sourceId: SourceId | undefined): PdfDocument | undefined {
    if (!sourceId || sourceId === this.#primarySource) return this.#doc
    if (this.#secondaryId === sourceId && this.#secondary) return this.#secondary

    const bytes = this.#sources.get(sourceId)
    if (!bytes) return this.#doc

    this.#secondary?.close()
    this.#secondary = PdfDocument.open(bytes)
    this.#secondaryId = sourceId
    return this.#secondary
  }

  /**
   * The exported document.
   *
   * With no edits, returns the user's original bytes untouched rather than a
   * MuPDF re-serialisation — an unedited download should hand back exactly
   * what was opened, not a normalised file with a different size. An e2e
   * test (e2e/download.spec.ts) asserts that byte-for-byte identity.
   *
   * With edits, `replay` opens a SECOND document from `#sourceBytes` and
   * never touches `#doc`, so exporting cannot invalidate a rendered page —
   * spec §1.5's deferred-bake invariant.
   *
   * Returned by structured clone, not transfer: the `renderResult` handler in
   * transferHandlers.ts only matches objects carrying an `rgba` field, so a
   * bare Uint8Array is copied across the boundary and `#sourceBytes` survives.
   * The "can be called twice" test pins that.
   */
  save(
    editDoc?: EditDocument,
    fonts?: Map<string, Uint8Array>,
    onProgress?: (done: number, total: number) => void,
    onStripped?: (found: StrippedContent) => void,
    protection?: Protection,
    removeProtection?: boolean,
  ): Uint8Array {
    const primary = this.#primarySource
    const src = primary ? this.#sources.get(primary) : undefined
    if (!src) throw new Error('no document open')
    // No edit document at all means "give me the file back" -- the caller
    // has nothing to replay.
    // No edit document AND no protection means "give me the file back".
    // Protection alone is a reason to go through the write path: someone
    // who opened a file and asked only for a password must get an
    // encrypted file, not their original.
    if (!editDoc && !protection && !removeProtection) return src
    if (!editDoc) {
      throw new Error('Cannot protect a document with no edit state.')
    }
    // `fonts` is only consulted for text objects; a document without any
    // never touches it, which is why it stays optional (Task 31). Under
    // exactOptionalPropertyTypes, `{ fonts: undefined }` is NOT the same as
    // omitting the key, so each property is only set when there is one.
    //
    // onProgress is a Comlink proxy: calling it posts a message and returns
    // a promise this deliberately does not await. Awaiting would make the
    // export wait on a main-thread round trip per page, and nothing here
    // needs the acknowledgement.
    return replay(this.#sources, editDoc, {
      ...(fonts ? { fonts } : {}),
      ...(onProgress ? { onProgress } : {}),
      ...(onStripped ? { onStripped } : {}),
      ...(protection ? { protection } : {}),
      ...(removeProtection ? { removeProtection } : {}),
      ...(this.#passwords.size > 0 ? { passwords: this.#passwords } : {}),
    })
  }

  /**
   * Character-level text geometry for one page, in MuPDF page space.
   * See pdf-core/src/text/index.ts for why that space and not raw PDF space.
   */
  /**
   * Character-level text geometry for one page OF ONE SOURCE.
   *
   * `sourceId` is not optional decoration. This used to read `#doc` -- the
   * primary document -- whatever page it was asked for, while `render()`
   * and `listFields()` both went through `#docFor`. In a merged document
   * every page carries its own file's index, and two files' first pages are
   * both `sourceIndex` 0, so page two of a merge asked for "page 0" and got
   * page one of the FIRST file: its text, its line boxes, its content in
   * the editor.
   *
   * The cache is keyed by source as well as page for the same reason. Keyed
   * by page alone, two sources' page 0 were the same cache entry, so even a
   * corrected lookup would have been served the wrong file's answer.
   */
  quadIndex(sourceId: SourceId | undefined, page: number): PageQuadIndex {
    const doc = this.#docFor(sourceId)
    if (!doc) throw new Error('no document open')
    const key = `${sourceId ?? this.#primarySource ?? 'primary'}:${page}`
    const hit = this.#quadCache.get(key)
    if (hit) return hit
    const index = buildQuadIndex(doc, page)
    this.#quadCache.set(key, index)
    return index
  }

  /**
   * Every image one page DRAWS, in draw order.
   *
   * The counterpart to `quadIndex`, cached the same way and keyed by source
   * as well as page for the same reason: two files' first pages are both
   * `sourceIndex` 0, and a cache keyed by page alone would serve one file's
   * images for the other's page.
   *
   * Reads from the SOURCE document rather than an export copy, like
   * `quadIndex` and `listFields`: the overlay draws targets over the page
   * as rendered, and the page as rendered is the source page.
   */
  imageIndex(sourceId: SourceId | undefined, page: number): PageImageIndex {
    const doc = this.#docFor(sourceId)
    if (!doc) throw new Error('no document open')
    const key = `${sourceId ?? this.#primarySource ?? 'primary'}:${page}`
    const hit = this.#imageCache.get(key)
    if (hit) return hit
    const index = buildImageIndex(doc, page)
    this.#imageCache.set(key, index)
    return index
  }

  /**
   * One of a page's own images, as pixels, cropped to where it sits.
   *
   * Rasterised rather than lifted out of the file -- see `cropImage`, which
   * carries the three measurements behind that choice. Deliberately NOT
   * cached: a crop is asked for once, at the moment an image is first
   * dragged, and holding a page-sized RGBA buffer per image afterwards
   * would cost far more than re-rendering the rare second time.
   */
  imageCrop(
    sourceId: SourceId | undefined,
    page: number,
    imageIndex: number,
    scale: number,
  ): { data: Uint8Array; hash: string } | undefined {
    const doc = this.#docFor(sourceId)
    if (!doc) throw new Error('no document open')
    const out = cropImage(doc, page, imageIndex, scale)
    return out ? { data: out.data, hash: out.hash } : undefined
  }

  /**
   * ANY rectangle of a page, as pixels.
   *
   * The counterpart to `imageCrop` for everything that is not an image --
   * vector logos, tables, a block of text. Not cached, for the same
   * reason: a crop is asked for once, at the moment a region is lifted.
   */
  regionCrop(
    sourceId: SourceId | undefined,
    page: number,
    rect: { x: number; y: number; w: number; h: number },
    scale: number,
  ): { data: Uint8Array } | undefined {
    const doc = this.#docFor(sourceId)
    if (!doc) throw new Error('no document open')
    return cropRegion(doc, page, rect, scale)
  }

  /**
   * The form fields on one page of one source.
   *
   * Reads from the SOURCE document, not from an assembled export copy: the
   * fill overlay draws over the page as rendered, and the page as rendered
   * is the source page. Uses the same #docFor handle cache as render(), so
   * a merged document's fields are readable without reopening per call.
   *
   * `pageRef` keys unnamed fields and names the source page rather than the
   * document page -- a document page can be reordered or duplicated, and
   * two document pages cloned from one source page show the same widget.
   */
  listFields(sourceId: SourceId | undefined, page: number): SourceField[] {
    const doc = this.#docFor(sourceId)
    if (!doc) throw new Error('no document open')
    return listFields(doc._raw(), page, `${sourceId ?? this.#primarySource ?? 'src-0'}:${page}`)
  }

  /**
   * The description the source document carries.
   *
   * Read from the source rather than from an export copy, because the
   * dialog opens on what the user's file already says -- an export copy
   * would already have this build's Producer stamped on it.
   */
  metadata(): DocumentMetadata {
    const doc = this.#doc
    if (!doc) throw new Error('no document open')
    return readMetadata(doc._raw())
  }

  /**
   * Compress the export, returning both sizes so the UI can show the trade
   * before committing to it.
   *
   * Runs over the EXPORTED bytes rather than the source, because that is
   * what the user is about to download -- estimating against the original
   * would quote a saving on a file that no longer exists.
   */
  compress(
    preset: CompressionPreset,
    editDoc?: EditDocument,
    fonts?: Map<string, Uint8Array>,
  ): CompressionResult {
    const exported = this.save(editDoc, fonts)
    return recompressImages(exported, preset)
  }

  /**
   * One page as a JPEG or PNG.
   *
   * Renders the SOURCE page, not the export. Image export is a snapshot of
   * the document as it is read, and routing it through `save` would make a
   * page export cost a whole-document write -- for a 300-page file, per
   * page.
   *
   * Nothing here touches the network. This is the one conversion in the
   * product that needs no backend at all, which is why it lives in the
   * worker beside the renderer rather than behind the job API.
   */
  rasterise(
    page: number,
    dpi: number,
    format: RasterFormat = 'jpeg',
    quality?: number,
  ): RasterisedPage {
    const doc = this.#doc
    if (!doc) throw new Error('no document open')
    return rasterisePage(doc, page, dpi, format, quality === undefined ? {} : { quality })
  }

  /** The pixel dimensions a rasterise would produce, without doing one. */
  rasterSize(page: number, dpi: number): { width: number; height: number } {
    const doc = this.#doc
    if (!doc) throw new Error('no document open')
    return rasterSize(doc, page, dpi)
  }

  /**
   * Every match for `query` across the whole document.
   *
   * Runs IN THE WORKER rather than shipping quad indices to the main
   * thread. A 300-page document would otherwise mean 300 round trips and
   * 300 index payloads for a search that touches each page once -- and the
   * worker already caches the indices it builds, so a second search over
   * the same document costs no extraction at all.
   *
   * `limit` bounds the result set. A one-letter query on a long document
   * matches tens of thousands of times, and neither the panel nor the
   * highlight layer can use that many; the count is reported honestly as
   * capped rather than the extras being dropped in silence.
   */
  find(query: string, options: FindOptions = {}, limit = 500): {
    matches: Array<{ page: number } & Match>
    capped: boolean
  } {
    const doc = this.#doc
    if (!doc) throw new Error('no document open')
    if (query === '') return { matches: [], capped: false }

    const matches: Array<{ page: number } & Match> = []
    for (let page = 0; page < doc.pageCount; page++) {
      for (const match of findInPage(this.quadIndex(undefined, page), query, options)) {
        if (matches.length >= limit) return { matches, capped: true }
        matches.push({ page, ...match })
      }
    }
    return { matches, capped: false }
  }

  /**
   * Which characters a font cannot draw.
   *
   * Asked of the worker because only it has the font machinery. MuPDF
   * returns glyph 0 -- the .notdef box -- rather than failing, so without
   * this check a patch silently becomes a row of empty rectangles.
   */
  missingGlyphs(fontBytes: Uint8Array, family: string, text: string): string[] {
    return missingGlyphsFor(fontBytes, family, text)
  }

  close(): void {
    this.#doc?.close()
    this.#doc = undefined
    this.#secondary?.close()
    this.#secondary = undefined
    this.#secondaryId = undefined
    // Every source, not just the first: a merged-away document still costs
    // its full byte payload until it is dropped.
    this.#sources.clear()
    this.#primarySource = undefined
    this.#passwords.clear()
    this.#quadCache.clear()
    this.#imageCache.clear()
  }
}
