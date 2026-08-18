import * as Comlink from 'comlink'
import { PdfService } from './pdfService'
import './transferHandlers'

Comlink.expose(new PdfService())

// Readiness handshake (Task 15a): this module's graph pulls in `mupdf`,
// which fetches and instantiates ~10MB of WASM — that async work yields the
// event loop, so `Comlink.expose()` above doesn't finish registering its
// `message` listener until some time after this worker script starts
// loading. A caller that posts its first RPC immediately after `new
// Worker(...)` can send it before that listener exists; the message is
// then silently dropped (confirmed in a real browser — see
// task-15a-report.md). Posting this once `Comlink.expose()` has run tells
// `pdfClient.ts`'s `createPdfClient()` it is now safe to send real
// requests. Comlink's own listener (registered by `Comlink.wrap()` on the
// *main-thread* side) also sees this message but ignores it silently — it
// only acts on messages carrying a Comlink protocol `id`, which this one
// doesn't have.
self.postMessage({ __pdfWorkerReady: true })
