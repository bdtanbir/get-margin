import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import PageGrid from '@/features/pages/PageGrid.vue'
import AddSourceButton from '@/features/pages/AddSourceButton.vue'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { seedPages } from '../helpers/seedDocument'

const GEOM = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }

/**
 * `file.arrayBuffer()` goes through the FileReader polyfill in
 * test/setup.ts, which resolves on a MACROTASK. flushPromises alone returns
 * while the handler is still suspended on it, so the assertions run before
 * anything has happened.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await new Promise((r) => setTimeout(r, 0))
  }
}
const addSource = vi.fn()

vi.mock('@/workers/pdfClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/workers/pdfClient')>()
  return { ...actual, getPdfClient: () => ({ addSource }) }
})

/** Register a second document the way AddSourceButton does. */
function addSecondSource(pageCount = 2, name = 'b.pdf'): void {
  useDocumentStore().addSource({
    id: 'src-1',
    name,
    size: 10,
    hash: 'h2',
    geometries: Array.from({ length: pageCount }, () => GEOM),
  })
}

describe('merge', () => {
  let doc: ReturnType<typeof useDocumentStore>
  let edits: ReturnType<typeof useEditsStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    seedPages(3)
    doc = useDocumentStore()
    edits = useEditsStore()
  })

  it('appends the second document’s pages', () => {
    addSecondSource(2)
    expect(doc.pageCount).toBe(5)
    expect(Object.keys(doc.sources)).toHaveLength(2)
  })

  it('keeps each page pointing at the file it came from', () => {
    addSecondSource(2)
    const added = doc.pageOrder.slice(3)
    for (const id of added) expect(edits.doc.pages[id]!.sourceId).toBe('src-1')
    for (const id of doc.pageOrder.slice(0, 3)) {
      expect(edits.doc.pages[id]!.sourceId).toBe('src-0')
    }
  })

  // Adding a document is an insertPages op, so it undoes like any other
  // page operation -- and the source registration goes with it.
  it('is undoable, source registration included', () => {
    addSecondSource(2)
    edits.undo()
    expect(doc.pageCount).toBe(3)
    expect(edits.doc.sources['src-1']).toBeUndefined()
  })

  it('shows a per-source header only once merged', () => {
    expect(mount(PageGrid).find('[data-source-header]').exists()).toBe(false)
    addSecondSource(2)
    const w = mount(PageGrid)
    const headers = w.findAll('[data-source-header]').map((h) => h.text())
    expect(headers).toEqual(['a.pdf', 'b.pdf'])
  })

  it('starts a new header wherever the source changes', () => {
    addSecondSource(1)
    // Interleave: a, b, a
    edits.applyOp(
      { type: 'reorderPages', pageOrder: [doc.pageOrder[0]!, doc.pageOrder[3]!, doc.pageOrder[1]!] },
      'Reorder',
    )
    const w = mount(PageGrid)
    expect(w.findAll('[data-source-header]').map((h) => h.text())).toEqual(['a.pdf', 'b.pdf', 'a.pdf'])
  })

  // graftPage carries no document-level structure, and a silently lost
  // table of contents is discovered long after the fact.
  it('says bookmarks are not carried over', () => {
    addSecondSource(2)
    expect(mount(PageGrid).get('[data-merge-notice]').text()).toContain('Bookmarks')
  })

  it('shows no merge notice for a single document', () => {
    expect(mount(PageGrid).find('[data-merge-notice]').exists()).toBe(false)
  })
})

describe('AddSourceButton', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    seedPages(3)
    addSource.mockResolvedValue({
      sourceId: 'src-1',
      pageCount: 2,
      geometries: [GEOM, GEOM],
    })
  })

  // TS 5.7+ made TypedArrays generic over their backing buffer; BlobPart
  // requires the ArrayBuffer-backed form specifically, so it is pinned here
  // (the same note as apps/web/test/stores/document.test.ts).
  function pick(w: ReturnType<typeof mount>, bytes: Uint8Array<ArrayBuffer>, type = 'application/pdf') {
    const file = new File([bytes], 'b.pdf', { type })
    const input = w.get('input[type=file]')
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
    return input.trigger('change')
  }

  const PDF: Uint8Array<ArrayBuffer> =
    new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 10, 10])
  const NOT_PDF: Uint8Array<ArrayBuffer> = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 10, 10, 10, 10])

  it('registers the picked file and appends its pages', async () => {
    const w = mount(AddSourceButton)
    await pick(w, PDF)
    await settle()
    expect(addSource).toHaveBeenCalledTimes(1)
    expect(useDocumentStore().pageCount).toBe(5)
  })

  // Magic bytes, not the extension -- the same rule openFile applies.
  it('refuses a file that is not a PDF', async () => {
    const w = mount(AddSourceButton)
    await pick(w, NOT_PDF)
    await settle()
    expect(addSource).not.toHaveBeenCalled()
    expect(useDocumentStore().error).toContain('not a PDF')
    expect(useDocumentStore().pageCount).toBe(3)
  })

  it('surfaces a worker failure without changing the document', async () => {
    addSource.mockRejectedValue(new Error('boom'))
    const w = mount(AddSourceButton)
    await pick(w, PDF)
    await settle()
    expect(useDocumentStore().error).toBe('boom')
    expect(useDocumentStore().pageCount).toBe(3)
  })
})
