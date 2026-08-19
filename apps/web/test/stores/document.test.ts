import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDocumentStore } from '../../src/stores/document.js'
import { useEditsStore } from '../../src/stores/edits.js'

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

  it('seeds the edit store with the same page ids it minted', async () => {
    const doc = useDocumentStore()
    const edits = useEditsStore()
    await doc.openFile(fakeFile('contract.pdf', PDF_BYTES))
    expect(edits.doc.pageOrder).toEqual(doc.pageOrder)
    // The source id is minted per open, so look it up rather than assuming.
    expect(Object.values(edits.doc.sources)[0]!.hash).toBe(doc.sourceHash)
  })
})

// Task 43. `doc.pages` returns EFFECTIVE geometry -- the source page's own
// box and rotation with the edit store's overrides folded in -- so every
// existing consumer of `page.geometry` picks up rotate and crop with no
// change to any of them.
describe('effective page geometry', () => {
  async function opened() {
    const doc = useDocumentStore()
    const edits = useEditsStore()
    await doc.openFile(fakeFile('a.pdf', PDF_BYTES))
    return { doc, edits, id: doc.pageOrder[0]! }
  }

  it('reports the source geometry when nothing overrides it', async () => {
    const { doc, id } = await opened()
    expect(doc.pages[id]!.geometry).toEqual(GEOM)
  })

  it('adds the edit rotation to the source rotation', async () => {
    const { doc, edits, id } = await opened()
    edits.applyOp({ type: 'rotatePage', pageId: id, by: 90 }, 'Rotate')
    expect(doc.pages[id]!.geometry.rotate).toBe(90)
  })

  it('normalises a rotation that wraps past 360', async () => {
    const { doc, edits, id } = await opened()
    edits.applyOp({ type: 'rotatePage', pageId: id, by: 270 }, 'Rotate')
    edits.applyOp({ type: 'rotatePage', pageId: id, by: 180 }, 'Rotate')
    expect(doc.pages[id]!.geometry.rotate).toBe(90)
  })

  it('leaves other pages alone when one is rotated', async () => {
    const { doc, edits, id } = await opened()
    const other = doc.pageOrder[1]!
    edits.applyOp({ type: 'rotatePage', pageId: id, by: 90 }, 'Rotate')
    expect(doc.pages[other]!.geometry.rotate).toBe(0)
  })

  it('prefers the crop override over the source CropBox', async () => {
    const { doc, edits, id } = await opened()
    edits.applyOp({ type: 'cropPage', pageId: id, cropBox: { x: 10, y: 20, w: 100, h: 200 } }, 'Crop')
    expect(doc.pages[id]!.geometry.cropBox).toEqual([10, 20, 110, 220])
  })

  it('follows the edit store’s page order, not the source order', async () => {
    const { doc, edits } = await opened()
    const [a, b, c] = doc.pageOrder
    edits.applyOp({ type: 'reorderPages', pageOrder: [c!, a!, b!] }, 'Reorder')
    expect(doc.pageOrder).toEqual([c, a, b])
    expect(doc.pageCount).toBe(3)
  })

  it('drops a deleted page from both getters', async () => {
    const { doc, edits, id } = await opened()
    edits.applyOp({ type: 'deletePages', pageIds: [id] }, 'Delete')
    expect(doc.pageOrder).not.toContain(id)
    expect(doc.pages[id]).toBeUndefined()
    expect(doc.pageCount).toBe(2)
  })

  it('registers the opened file as a source', async () => {
    const doc = useDocumentStore()
    await doc.openFile(fakeFile('contract.pdf', PDF_BYTES))
    const sources = Object.values(doc.sources)
    expect(sources).toHaveLength(1)
    expect(sources[0]!.name).toBe('contract.pdf')
    expect(sources[0]!.geometries).toHaveLength(3)
  })

  // `edits.doc` is replaced wholesale on every op, so without memoisation
  // the getter would hand every mounted page a fresh PageState object sixty
  // times a second during a drag and re-render all of them.
  it('keeps a page’s identity stable across unrelated edits', async () => {
    const { doc, edits, id } = await opened()
    const before = doc.pages[id]
    edits.applyOp({ type: 'rotatePage', pageId: doc.pageOrder[1]!, by: 90 }, 'Rotate')
    expect(doc.pages[id]).toBe(before)
  })

  it('gives a page a new identity when its own geometry changes', async () => {
    const { doc, edits, id } = await opened()
    const before = doc.pages[id]
    edits.applyOp({ type: 'rotatePage', pageId: id, by: 90 }, 'Rotate')
    expect(doc.pages[id]).not.toBe(before)
  })

  // pageOrder indexes pages; an id in one and not the other is an undefined
  // page prop downstream.
  it('never lists a page in pageOrder that pages cannot resolve', async () => {
    const { doc } = await opened()
    for (const id of doc.pageOrder) expect(doc.pages[id]).toBeDefined()
  })
})
