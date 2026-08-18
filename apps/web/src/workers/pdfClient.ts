import * as Comlink from 'comlink'
import type { PdfService, DocumentInfo, RenderResult } from './pdfService'
// Side-effect import: registers the `rgba` transfer handler on this end of
// the boundary. Must also be imported by pdf.worker.ts — see that file's
// comment in transferHandlers.ts for why both ends need it.
import './transferHandlers'

export type PdfClient = {
  open(bytes: Uint8Array): Promise<DocumentInfo>
  authenticate(password: string): Promise<DocumentInfo>
  /**
   * Renders one page. `signal`, if given, cancels the request — but only if
   * it fires before the worker has started rendering: MuPDF renders
   * synchronously inside WASM and cannot be interrupted mid-page. A resolved
   * `null` means "never started", not "aborted partway through". Still
   * worth wiring up: fast scrolling queues dozens of renders, and dropping
   * the stale ones before they start is the difference between a responsive
   * viewer and an unusable one.
   *
   * Per-request `AbortSignal` is *the* cancellation mechanism — there is no
   * bulk "cancel all except" API. Callers that manage many in-flight
   * renders (e.g. a virtualised viewport) should keep a
   * `Map<pageId, AbortController>` and `.abort()` the ones they no longer
   * want; `render()` handles the rest.
   */
  render(page: number, scale: number, signal?: AbortSignal): Promise<RenderResult | null>
  close(): Promise<void>
  terminate(): void
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
  const ready = new Promise<void>((resolve) => {
    worker.addEventListener('message', function onReady(ev: MessageEvent) {
      const data = ev.data as { __pdfWorkerReady?: boolean } | undefined
      if (data?.__pdfWorkerReady) {
        worker.removeEventListener('message', onReady)
        resolve()
      }
    })
  })

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

    async render(page, scale, signal) {
      await ready
      const id = nextId++
      if (signal?.aborted) return null
      const onAbort = (): void => { void remote.cancel(id) }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        return await remote.render({ id, page, scale })
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
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
