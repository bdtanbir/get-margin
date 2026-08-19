import {
  PdfDocument, renderPage, replay, buildQuadIndex, listFields,
  type EditDocument, type PageQuadIndex, type SourceId, type StrippedContent,
  type SourceField,
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
  #quadCache = new Map<number, PageQuadIndex>()

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

  authenticate(password: string): DocumentInfo {
    const doc = this.#doc
    if (!doc) throw new Error('no document open')
    if (!doc.authenticate(password)) throw new Error('Incorrect password')
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
  ): Uint8Array {
    const primary = this.#primarySource
    const src = primary ? this.#sources.get(primary) : undefined
    if (!src) throw new Error('no document open')
    // No edit document at all means "give me the file back" -- the caller
    // has nothing to replay.
    if (!editDoc) return src
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
    })
  }

  /**
   * Character-level text geometry for one page, in MuPDF page space.
   * See pdf-core/src/text/index.ts for why that space and not raw PDF space.
   */
  quadIndex(page: number): PageQuadIndex {
    const doc = this.#doc
    if (!doc) throw new Error('no document open')
    const hit = this.#quadCache.get(page)
    if (hit) return hit
    const index = buildQuadIndex(doc, page)
    this.#quadCache.set(page, index)
    return index
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
    this.#quadCache.clear()
  }
}
