import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { MessageChannel } from 'node:worker_threads'
import * as Comlink from 'comlink'
import { PdfService, type RenderResult } from '../../src/workers/pdfService.js'
import '../../src/workers/transferHandlers.js'
import { generateFixtures, fixturePath } from '../../../../packages/pdf-core/test/fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)

/**
 * Comlink structured-clones by default, which would *copy* `rgba` across
 * the boundary. A copy and a transfer produce an identical-looking result
 * on the receiving side, so asserting on `result.rgba` alone can't tell
 * them apart — the only observable difference is that a genuine transfer
 * detaches the sender's buffer (byteLength drops to 0), while a copy
 * leaves it intact. This test wires PdfService up to a real Comlink
 * endpoint (Node's MessageChannel implements the same postMessage /
 * addEventListener contract Comlink expects from a Worker) and checks the
 * sender-side buffer directly.
 */
describe('render transfer handler', () => {
  it('detaches the rgba buffer on the worker side after render crosses the boundary', async () => {
    const { port1, port2 } = new MessageChannel()
    const service = new PdfService()
    Comlink.expose(service, port1 as unknown as Comlink.Endpoint)
    const remote = Comlink.wrap<PdfService>(port2 as unknown as Comlink.Endpoint)

    const bytes = new Uint8Array(readFileSync(fixturePath('simple-text')))
    await remote.open(Comlink.transfer(bytes, [bytes.buffer]))

    // Capture the exact object PdfService.render hands back, before Comlink's
    // expose() wrapper serializes and posts it across the port.
    let captured: RenderResult | null = null
    const originalRender = service.render.bind(service)
    service.render = (req) => {
      captured = originalRender(req)
      return captured
    }

    const result = await remote.render({ id: 1, page: 0, scale: 1 })

    expect(result).not.toBeNull()
    expect(captured).not.toBeNull()
    // A copy would leave this at its original byteLength; a genuine
    // transfer detaches it, forcing byteLength to 0.
    expect(captured!.rgba.buffer.byteLength).toBe(0)
    // The receiving side still has a fully usable, correctly sized buffer —
    // the data moved, it didn't vanish.
    expect(result!.rgba.length).toBe(612 * 792 * 4)
    expect(result!.rgba.buffer.byteLength).toBeGreaterThan(0)

    remote[Comlink.releaseProxy]()
    port1.close()
    port2.close()
    service.close()
  })
})
