import * as Comlink from 'comlink'
import type { PdfService, DocumentInfo, RenderResult } from './pdfService'
import type {
  EditDocument, PageQuadIndex, PageImageIndex, SourceId, StrippedContent, SourceField, Protection,
  DocumentMetadata, CompressionPreset, CompressionResult, FindOptions, Match,
  RasterFormat, RasterisedPage,
} from '@margin/pdf-core'
// Side-effect import: registers the `rgba` transfer handler on this end of
// the boundary. Must also be imported by pdf.worker.ts — see that file's
// comment in transferHandlers.ts for why both ends need it.
import './transferHandlers'

// Failsafe only, not a synchronization mechanism — the message handshake
// below is what makes the happy path race-free. 60s is generous for a
// 10.4MB WASM fetch even on a slow connection; this only fires if the
// worker is genuinely stuck.
const WORKER_READY_TIMEOUT_MS = 60_000

export type PdfClient = {
  open(bytes: Uint8Array): Promise<DocumentInfo>
  authenticate(password: string): Promise<DocumentInfo>
  /**
   * Renders one page.
   *
   * There is no cancellation mechanism here, and deliberately so: Comlink's
   * `requestResponseMessage` posts the RENDER message synchronously, and
   * worker message delivery is FIFO, so a hypothetical `cancel(id)` posted
   * right after `render(id)` can never be processed before the render it
   * targets runs — the render always executes regardless. (An earlier
   * version of this method took an `AbortSignal` and posted a CANCEL
   * message on abort; it looked load-bearing but could not work for exactly
   * this reason, and was removed.)
   *
   * The actual abandonment mechanism lives one layer up, in
   * `stores/viewport.ts`'s `pump()`: it re-plans from the live `dirty` flag
   * between renders, so a scroll or zoom mid-drain stops queuing stale work
   * at the next render boundary instead of grinding through it. MuPDF
   * renders synchronously inside WASM and cannot be interrupted mid-page,
   * so "between renders" is the finest granularity cancellation can ever
   * have here — there is no finer mechanism to build.
   */
  render(page: number, scale: number, sourceId?: SourceId): Promise<RenderResult | null>
  /**
   * The exported document's bytes. See PdfService.save.
   *
   * `editDoc` is structure-cloned across the boundary, not transferred: the
   * store keeps owning it, and any Uint8Array inside it (image/signature
   * payloads) must survive on the main thread for the next export.
   */
  save(
    editDoc?: EditDocument,
    fonts?: Map<string, Uint8Array>,
    onProgress?: (done: number, total: number) => void,
    onStripped?: (found: StrippedContent) => void,
    protection?: Protection,
    removeProtection?: boolean,
  ): Promise<Uint8Array>
  /**
   * Character-level text geometry for one page of one source, cached in the
   * worker. See PdfService.quadIndex.
   *
   * `sourceId` is required rather than optional: omitting it silently meant
   * "the primary document", which is the wrong answer for every page of a
   * merged-in file and produced no error to notice.
   */
  quadIndex(sourceId: SourceId | undefined, page: number): Promise<PageQuadIndex>
  /**
   * Every image one page draws, in draw order. See PdfService.imageIndex.
   *
   * `sourceId` is required for the same reason it is on `quadIndex`:
   * omitting it silently means "the primary document", which is the wrong
   * answer for every page of a merged-in file.
   */
  imageIndex(sourceId: SourceId | undefined, page: number): Promise<PageImageIndex>
  /**
   * One of a page's images, as PNG pixels. See PdfService.imageCrop.
   *
   * Asked for at the moment an image is first dragged, not when the page's
   * index is built: rasterising every image on a page the user is only
   * looking at would be waste.
   */
  imageCrop(
    sourceId: SourceId | undefined,
    page: number,
    imageIndex: number,
    scale: number,
  ): Promise<{ data: Uint8Array; hash: string } | undefined>
  /**
   * The form fields on one page. See PdfService.listFields.
   *
   * Not cancellable and not queued behind renders: enumerating fields is
   * cheap next to rasterising a page, and the fill overlay needs an answer
   * for a page that is already on screen.
   */
  listFields(sourceId: SourceId | undefined, page: number): Promise<SourceField[]>
  /** The description the source document carries. See PdfService.metadata. */
  metadata(): Promise<DocumentMetadata>
  /** Every match across the document. See PdfService.find. */
  find(
    query: string,
    options?: FindOptions,
    limit?: number,
  ): Promise<{ matches: Array<{ page: number } & Match>; capped: boolean }>
  /** Characters the font cannot draw. See PdfService.missingGlyphs. */
  missingGlyphs(fontBytes: Uint8Array, family: string, text: string): Promise<string[]>
  /**
   * One page as a JPEG or PNG. See PdfService.rasterise.
   *
   * Nothing leaves the device: this is the one conversion in the product
   * with no API behind it.
   */
  rasterise(
    page: number,
    dpi: number,
    format?: RasterFormat,
    quality?: number,
  ): Promise<RasterisedPage>
  /** The pixel dimensions a rasterise would produce, without doing one. */
  rasterSize(page: number, dpi: number): Promise<{ width: number; height: number }>
  /** Compress the export. See PdfService.compress. */
  compress(
    preset: CompressionPreset,
    editDoc?: EditDocument,
    fonts?: Map<string, Uint8Array>,
  ): Promise<CompressionResult>
  /** Register another file for merging. See PdfService.addSource. */
  addSource(bytes: Uint8Array): Promise<{
    sourceId: SourceId
    pageCount: number
    geometries: import('@margin/transform').PageGeometry[]
  }>
  /** Forget a source's bytes. Ignored for the primary document. */
  dropSource(id: SourceId): Promise<void>
  /** Total retained source bytes, for bounding a merge. */
  openBytes(): Promise<number>
  close(): Promise<void>
  terminate(): void
}

/**
 * How long an export may run before the client gives up.
 *
 * The readiness handshake covers worker BOOT only; nothing else bounded
 * `save`, so a pathological document could leave the Download button
 * spinning forever with no way back. Generous enough that a 300-page
 * document with heavy edits finishes comfortably (measured in
 * docs/findings/05-export-performance.md).
 */
export const EXPORT_TIMEOUT_MS = 120_000

/**
 * Rejects with `message` if `promise` has not settled in time.
 *
 * The worker keeps running after a timeout -- there is no way to interrupt
 * synchronous WASM -- so this bounds the UI's wait, not the work. That is
 * the point: the user gets a retryable error instead of a dead button.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>
}

/**
 * Creates a new Worker + MuPDF instance. Prefer `getPdfClient()` in app
 * code — this is exported so tests can get an isolated instance per case.
 */
export function createPdfClient(): PdfClient {
  const worker = new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' })

  // Readiness handshake (Task 15a). pdf.worker.ts's module graph pulls in
  // `mupdf`, which fetches and instantiates ~10MB of WASM before
  // `Comlink.expose()` finishes registering its `message` listener — real
  // async work that yields the event loop. A message posted to `worker`
  // before that listener exists is silently dropped in a real browser (no
  // error, no rejection — confirmed by direct reproduction; see
  // task-15a-report.md), so every method below waits on `ready` before
  // touching `remote`.
  //
  // This listener is attached synchronously, in the same tick as
  // `new Worker(...)`, before any `await` in this function — required for
  // correctness, not just style. If it were attached after an `await`, the
  // worker could already have posted its ready signal by the time the
  // listener existed, and `ready` would then hang forever waiting for a
  // message that already came and went. Attaching it here is safe from that
  // failure mode for the opposite reason the original bug existed: the
  // worker cannot execute *any* of its own script — let alone post a
  // message — until `new Worker(...)` above has returned control to this
  // synchronous block, so there is no interleaving in which the ready
  // signal could arrive before this listener is registered.
  const ready = new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      worker.removeEventListener('message', onReady)
      worker.removeEventListener('error', onError)
      clearTimeout(timer)
    }

    const onReady = (ev: MessageEvent): void => {
      const data = ev.data as { __pdfWorkerReady?: boolean } | undefined
      if (data?.__pdfWorkerReady) {
        cleanup()
        resolve()
      }
    }

    // Fires if the worker's module graph throws while evaluating — WASM
    // instantiation failing on an unsupported browser, a blocked or
    // corrupted asset — or if the worker script itself fails to load (a
    // network error, a CSP rejection). Any of these means execution never
    // reaches `self.postMessage({ __pdfWorkerReady: true })` in
    // pdf.worker.ts, so without this handler `ready` — and every PdfClient
    // method that awaits it — would hang forever with zero console output:
    // exactly the silent-hang class this task exists to eliminate, reached
    // from a different direction than the original message-drop race.
    const onError = (ev: ErrorEvent): void => {
      cleanup()
      reject(
        new Error(`PDF worker ("pdf.worker.ts") failed to start: ${ev.message || 'unknown error'}`, {
          cause: ev.error,
        }),
      )
    }

    const timer = setTimeout(() => {
      cleanup()
      reject(
        new Error(
          'The PDF worker did not become ready within 60 seconds. It may have failed to load, ' +
            'or your browser may not support a required feature. Try reloading the page.',
        ),
      )
    }, WORKER_READY_TIMEOUT_MS)

    worker.addEventListener('message', onReady)
    worker.addEventListener('error', onError)
  })
  // Nobody may be awaiting `ready` yet at the moment it settles — e.g. a
  // client created but never used before the page navigates away. Without
  // this, a genuine boot failure or timeout would log an "Uncaught (in
  // promise)" warning for a rejection nothing was listening to. This does
  // not swallow the real rejection: `ready` itself is untouched, and every
  // `await ready` below still throws normally.
  ready.catch(() => {})

  const remote = Comlink.wrap<PdfService>(worker)
  let nextId = 1

  return {
    // Transfer the buffer rather than copying it — a 100MB PDF copied twice is
    // 200MB of avoidable pressure on a phone. This neuters `bytes` on the main
    // thread: callers must not read it again after calling open() (capture
    // name/size/hash beforehand, per the spec's §4 privacy stance).
    async open(bytes) {
      await ready
      return remote.open(Comlink.transfer(bytes, [bytes.buffer]))
    },

    async authenticate(password) {
      await ready
      return remote.authenticate(password)
    },

    async render(page, scale, sourceId) {
      await ready
      const id = nextId++
      return await remote.render({ id, page, scale, ...(sourceId ? { sourceId } : {}) })
    },

    async listFields(sourceId, page) {
      await ready
      return remote.listFields(sourceId, page)
    },

    async metadata() {
      await ready
      return remote.metadata()
    },

    async find(query, options, limit) {
      await ready
      return remote.find(query, options, limit)
    },

    async missingGlyphs(fontBytes, family, text) {
      await ready
      return remote.missingGlyphs(fontBytes, family, text)
    },

    async rasterise(page, dpi, format, quality) {
      await ready
      return withTimeout(
        remote.rasterise(page, dpi, format, quality),
        EXPORT_TIMEOUT_MS,
        'Exporting that page as an image took too long and was stopped.',
      )
    },

    async rasterSize(page, dpi) {
      await ready
      return remote.rasterSize(page, dpi)
    },

    async compress(preset, editDoc, fonts) {
      await ready
      return withTimeout(
        remote.compress(preset, editDoc, fonts),
        EXPORT_TIMEOUT_MS,
        'Compressing took too long and was stopped.',
      )
    },

    async save(editDoc, fonts, onProgress, onStripped, protection, removeProtection) {
      await ready
      // Comlink.proxy so the worker can CALL these rather than receiving a
      // structured clone of them (functions do not clone).
      const progress = onProgress ? Comlink.proxy(onProgress) : undefined
      const stripped = onStripped ? Comlink.proxy(onStripped) : undefined
      return withTimeout(
        remote.save(editDoc, fonts, progress, stripped, protection, removeProtection),
        EXPORT_TIMEOUT_MS,
        'The export took too long and was stopped. Try again, or remove some edits.',
      )
    },

    async quadIndex(sourceId, page) {
      await ready
      return remote.quadIndex(sourceId, page)
    },

    async imageIndex(sourceId, page) {
      await ready
      return remote.imageIndex(sourceId, page)
    },

    async imageCrop(sourceId, page, imageIndex, scale) {
      await ready
      return remote.imageCrop(sourceId, page, imageIndex, scale)
    },

    async addSource(bytes) {
      await ready
      // Transferred, like open(): the main thread must not read these bytes
      // again, and a copy of a 150MB file is exactly what merge cannot afford.
      return remote.addSource(Comlink.transfer(bytes, [bytes.buffer]))
    },

    async dropSource(id) {
      await ready
      return remote.dropSource(id)
    },

    async openBytes() {
      await ready
      return remote.openBytes()
    },

    async close() {
      await ready
      return remote.close()
    },

    // No `await ready` here: terminating a worker that never finished
    // booting is still a valid, immediate operation — there is nothing to
    // wait for, and waiting would make `terminate()` from a stuck boot
    // impossible.
    terminate() {
      remote[Comlink.releaseProxy]()
      worker.terminate()
    },
  }
}

let shared: PdfClient | undefined

/**
 * The app-wide PdfClient singleton.
 *
 * The document lives inside one worker's MuPDF instance (spec §1.5: one
 * worker per document). If the document store and the viewport store each
 * created their own client, they'd get two Workers and two MuPDF instances —
 * the store that opened the document would leave the store that renders it
 * talking to a worker that never received it, so every render would fail
 * with "no document open". Every unit test still passes in that scenario
 * because both stores mock the client module; it only shows up in the
 * browser, as a viewer that renders nothing. Lazily create the one shared
 * instance here instead, and let `createPdfClient()` remain available for
 * tests that want an isolated worker.
 */
export function getPdfClient(): PdfClient {
  shared ??= createPdfClient()
  return shared
}

/** Closes the shared client's document if one was ever created. No-ops otherwise. */
export async function closeSharedDocument(): Promise<void> {
  await shared?.close()
}
