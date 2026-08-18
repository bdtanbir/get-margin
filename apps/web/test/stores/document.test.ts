import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDocumentStore } from '../../src/stores/document.js'

const GEOM = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }

// TS 5.7+ made TypedArrays generic over their backing buffer, defaulting a
// bare `Uint8Array` annotation to `Uint8Array<ArrayBufferLike>` (which
// admits SharedArrayBuffer) — `BlobPart` requires the ArrayBuffer-backed
// form specifically, so the generic must be pinned here.
function fakeFile(name: string, bytes: Uint8Array<ArrayBuffer>): File {
  return new File([bytes], name, { type: 'application/pdf' })
}
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 10, 10])
const NOT_PDF = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 10, 10, 10, 10])

const client = {
  open: vi.fn(),
  authenticate: vi.fn(),
  render: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  terminate: vi.fn(),
}

// A1: the store reads the shared client through `getPdfClient()`, not
// `createPdfClient()` — mocking only the latter would leave the real
// accessor in place and jsdom would try to spawn an actual Worker.
vi.mock('../../src/workers/pdfClient.js', () => ({
  createPdfClient: () => client,
  getPdfClient: () => client,
  // Mirrors the real closeSharedDocument(): delegates to the shared
  // client's close() rather than being its own independent spy.
  closeSharedDocument: () => client.close(),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  client.open.mockResolvedValue({ pageCount: 3, geometries: [GEOM, GEOM, GEOM], needsPassword: false })
  client.close.mockResolvedValue(undefined)
})

describe('useDocumentStore.openFile', () => {
  it('starts empty', () => {
    const s = useDocumentStore()
    expect(s.status).toBe('empty')
    expect(s.pageCount).toBe(0)
  })

  it('reaches ready and builds page state', async () => {
    const s = useDocumentStore()
    await s.openFile(fakeFile('contract.pdf', PDF_BYTES))
    expect(s.status).toBe('ready')
    expect(s.fileName).toBe('contract.pdf')
    expect(s.pageOrder).toHaveLength(3)
    expect(s.pageCount).toBe(3)
  })

  it('assigns unique synthetic page ids, not indices', async () => {
    const s = useDocumentStore()
    await s.openFile(fakeFile('a.pdf', PDF_BYTES))
    const ids = s.pageOrder
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) expect(id).not.toMatch(/^\d+$/)
    expect(s.pages[ids[0]!]!.sourceIndex).toBe(0)
    expect(s.pages[ids[2]!]!.sourceIndex).toBe(2)
  })

  it('exposes geometry by page id', async () => {
    const s = useDocumentStore()
    await s.openFile(fakeFile('a.pdf', PDF_BYTES))
    expect(s.geometryOf(s.pageOrder[1]!)).toEqual(GEOM)
  })

  it('computes a source hash before the buffer is transferred', async () => {
    const s = useDocumentStore()
    await s.openFile(fakeFile('a.pdf', PDF_BYTES))
    expect(s.sourceHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a file whose magic bytes are not %PDF', async () => {
    const s = useDocumentStore()
    await s.openFile(fakeFile('sneaky.pdf', NOT_PDF))
    expect(s.status).toBe('error')
    expect(s.error).toMatch(/not a PDF/i)
    expect(client.open).not.toHaveBeenCalled()
  })

  it('enters needs-password for an encrypted document', async () => {
    client.open.mockResolvedValue({ pageCount: 0, geometries: [], needsPassword: true })
    const s = useDocumentStore()
    await s.openFile(fakeFile('locked.pdf', PDF_BYTES))
    expect(s.status).toBe('needs-password')
    expect(s.pageOrder).toHaveLength(0)
  })

  it('becomes ready after a correct password', async () => {
    client.open.mockResolvedValue({ pageCount: 0, geometries: [], needsPassword: true })
    client.authenticate.mockResolvedValue({ pageCount: 2, geometries: [GEOM, GEOM], needsPassword: false })
    const s = useDocumentStore()
    await s.openFile(fakeFile('locked.pdf', PDF_BYTES))
    await s.submitPassword('secret')
    expect(s.status).toBe('ready')
    expect(s.pageOrder).toHaveLength(2)
  })

  it('stays in needs-password after a wrong password and reports it', async () => {
    client.open.mockResolvedValue({ pageCount: 0, geometries: [], needsPassword: true })
    client.authenticate.mockRejectedValue(new Error('Incorrect password'))
    const s = useDocumentStore()
    await s.openFile(fakeFile('locked.pdf', PDF_BYTES))
    await s.submitPassword('wrong')
    expect(s.status).toBe('needs-password')
    expect(s.error).toMatch(/incorrect password/i)
  })

  it('surfaces a worker failure as an error state', async () => {
    client.open.mockRejectedValue(new Error('boom'))
    const s = useDocumentStore()
    await s.openFile(fakeFile('a.pdf', PDF_BYTES))
    expect(s.status).toBe('error')
    expect(s.error).toBeTruthy()
  })

  it('never retains the file bytes', async () => {
    const s = useDocumentStore()
    await s.openFile(fakeFile('a.pdf', PDF_BYTES))
    // Spec §4: only name, size, and hash live on the main thread.
    expect(Object.values(s.$state).some((v) => v instanceof Uint8Array || v instanceof ArrayBuffer)).toBe(false)
  })

  it('reset returns to empty and releases the worker', async () => {
    const s = useDocumentStore()
    await s.openFile(fakeFile('a.pdf', PDF_BYTES))
    await s.reset()
    expect(s.status).toBe('empty')
    expect(s.pageOrder).toHaveLength(0)
    expect(client.close).toHaveBeenCalled()
  })

  // A4: the brief's own tests only check pageCount after a *successful*
  // second open, which can't catch stale page state surviving a failed
  // one. Open a valid document, then a corrupt one, and confirm the first
  // document's pages don't linger into the error state.
  it('clears a previously open document when the next open fails', async () => {
    const s = useDocumentStore()
    await s.openFile(fakeFile('a.pdf', PDF_BYTES))
    expect(s.pageCount).toBe(3)

    await s.openFile(fakeFile('sneaky.pdf', NOT_PDF))
    expect(s.status).toBe('error')
    expect(s.pageCount).toBe(0)
    expect(s.pageOrder).toHaveLength(0)
  })
})
