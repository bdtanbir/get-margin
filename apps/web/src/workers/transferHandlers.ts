import * as Comlink from 'comlink'
import type { RenderResult } from './pdfService'

/**
 * Comlink structured-clones return values by default, which would copy
 * `rgba` — a decoded page bitmap, tens of megabytes at typical zoom —
 * across the worker boundary on every render. `renderPage` (pdf-core) hands
 * back a freshly allocated, exactly-sized `Uint8Array` precisely so it can
 * be *transferred* instead: this handler is what makes that transfer
 * actually happen for values crossing the Comlink boundary.
 *
 * Transfer handlers must be registered identically on both sides before any
 * message crosses the boundary, so this module has no exports — it is
 * imported for its side effect (registration) by both pdf.worker.ts and
 * pdfClient.ts. Importing it twice (or from both ends) is safe: `.set()` on
 * the same key is idempotent.
 */
function isRenderResult(value: unknown): value is RenderResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'rgba' in value &&
    (value as { rgba: unknown }).rgba instanceof Uint8Array
  )
}

Comlink.transferHandlers.set('renderResult', {
  canHandle: isRenderResult,
  serialize(value: RenderResult): [RenderResult, Transferable[]] {
    return [value, [value.rgba.buffer]]
  },
  deserialize(value: RenderResult): RenderResult {
    return value
  },
})
