import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPdfClient } from '../../src/workers/pdfClient.js'

/**
 * Task 15a follow-up: the readiness handshake added to close the
 * worker-boot race (see task-15a-report.md) had no error or timeout path —
 * if the worker's module graph throws while evaluating (WASM instantiation
 * failing, a corrupted asset, a CSP rejection) or the worker script fails
 * to load at all, `self.postMessage({ __pdfWorkerReady: true })` in
 * pdf.worker.ts is never reached, and every PdfClient method hangs on
 * `await ready` forever with zero console output — the exact silent-hang
 * class this task exists to eliminate, reached from a different direction.
 *
 * A real browser Worker isn't available under Vitest (no DOM `Worker`
 * global in Node; jsdom doesn't implement genuine multi-threaded workers
 * either), so this stubs the global `Worker` constructor with a minimal
 * `EventTarget` double. That does NOT prove a real browser's Worker
 * error/close semantics match this stub — the e2e suite
 * (apps/web/e2e/worker-boot.spec.ts) is what proves the real, happy-path
 * boundary works in an actual browser. What this proves instead is
 * `createPdfClient()`'s own error/timeout logic: it rejects with an
 * actionable message, and it does so exactly once, given the events it's
 * designed to handle.
 */
class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = []
  terminated = false

  constructor(..._args: unknown[]) {
    super()
    FakeWorker.instances.push(this)
  }

  postMessage(): void {
    // No-op: these tests never let `ready` resolve via a real Comlink round
    // trip, so nothing on the other end needs to respond.
  }

  terminate(): void {
    this.terminated = true
  }
}

beforeEach(() => {
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('createPdfClient readiness handshake — error and timeout paths', () => {
  it('rejects pending calls if the worker fires an error event before becoming ready', async () => {
    const client = createPdfClient()
    const worker = FakeWorker.instances[0]
    expect(worker).toBeDefined()

    const openPromise = client.open(new Uint8Array([1, 2, 3]))

    worker!.dispatchEvent(
      Object.assign(new Event('error'), {
        message: 'WebAssembly.instantiate failed',
        error: new Error('unsupported'),
      }),
    )

    await expect(openPromise).rejects.toThrow(
      /PDF worker.*failed to start.*WebAssembly\.instantiate failed/,
    )
  })

  it('rejects pending calls if the worker never becomes ready within the timeout', async () => {
    vi.useFakeTimers()
    const client = createPdfClient()

    const openPromise = client.open(new Uint8Array([1, 2, 3]))
    const assertion = expect(openPromise).rejects.toThrow(/did not become ready within 60 seconds/)

    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
  })

  it('does not throw or double-reject if the worker errors after the timeout already fired', async () => {
    // Guards the cleanup logic: once `ready` settles, both the `error` and
    // `message` listeners must be removed, so a late/unrelated `error`
    // event can't blow up trying to reject an already-settled promise.
    vi.useFakeTimers()
    const client = createPdfClient()
    const worker = FakeWorker.instances[0]!

    const openPromise = client.open(new Uint8Array([1, 2, 3]))
    const assertion = expect(openPromise).rejects.toThrow(/did not become ready/)
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion

    expect(() =>
      worker.dispatchEvent(Object.assign(new Event('error'), { message: 'late', error: new Error('late') })),
    ).not.toThrow()
  })

  it('resolves readiness on the ready message and stops listening for error/timeout afterward', async () => {
    vi.useFakeTimers()
    const client = createPdfClient()
    const worker = FakeWorker.instances[0]!

    worker.dispatchEvent(new MessageEvent('message', { data: { __pdfWorkerReady: true } }))

    // `open()` still won't resolve — this FakeWorker never answers the real
    // Comlink RPC it triggers once `ready` unblocks — but the timeout must
    // no longer be armed. Probe that indirectly: advance fully past what
    // would have been the 60s timeout and confirm `open()` is still merely
    // pending (not rejected with the timeout message).
    const openPromise = client.open(new Uint8Array([1]))
    let rejected = false
    openPromise.catch(() => {
      rejected = true
    })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(rejected).toBe(false)

    // A stray error event after readiness must be a no-op too.
    expect(() =>
      worker.dispatchEvent(Object.assign(new Event('error'), { message: 'late', error: new Error('late') })),
    ).not.toThrow()
  })
})
