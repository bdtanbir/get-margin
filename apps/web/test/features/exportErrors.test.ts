import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import TopBar from '@/app/TopBar.vue'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { withTimeout } from '@/workers/pdfClient'
import * as exportFile from '@/lib/exportFile'
import type { EditObject } from '@margin/pdf-core'

const save = vi.fn()

vi.mock('@/workers/pdfClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/workers/pdfClient')>()
  return { ...actual, getPdfClient: () => ({ save }) }
})

vi.mock('@/lib/fonts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fonts')>()
  return { ...actual, fontsForExport: vi.fn(async () => new Map()) }
})

const GEOM = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }

function readyDoc(pages: number): void {
  const doc = useDocumentStore()
  doc.$patch({
    status: 'ready',
    fileName: 'contract.pdf',
    pageOrder: Array.from({ length: pages }, (_, i) => `p${i}`),
    pages: Object.fromEntries(
      Array.from({ length: pages }, (_, i) => [`p${i}`, { id: `p${i}`, sourceIndex: i, geometry: GEOM }]),
    ),
  })
}

describe('export error surfaces', () => {
  let downloadBytes: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    save.mockResolvedValue(new Uint8Array([1, 2, 3]))
    downloadBytes = vi.spyOn(exportFile, 'downloadBytes').mockImplementation(() => {})
    readyDoc(3)
    useEditsStore().reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p0'], { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
  })

  const click = async (w: ReturnType<typeof mount>) => {
    await w.get('[data-download]').trigger('click')
    await flushPromises()
  }

  it('downloads the exported bytes on success', async () => {
    const w = mount(TopBar)
    await click(w)
    expect(downloadBytes).toHaveBeenCalledTimes(1)
  })

  // NEVER hand the user a partial PDF that silently dropped an edit: they
  // will not notice the omission.
  it('triggers no download when the export fails', async () => {
    save.mockRejectedValue(new Error('Could not export the signature on page 3: boom'))
    const w = mount(TopBar)
    await click(w)
    expect(downloadBytes).not.toHaveBeenCalled()
  })

  it('surfaces the failing object kind and page from the writer', async () => {
    save.mockRejectedValue(new Error('Could not export the signature on page 3: boom'))
    const w = mount(TopBar)
    await click(w)
    expect(useDocumentStore().error).toContain('signature on page 3')
  })

  it('surfaces the named font error rather than a generic failure', async () => {
    save.mockRejectedValue(
      new Error('font "Merriweather" was not provided to the export. Load it before exporting.'),
    )
    const w = mount(TopBar)
    await click(w)
    expect(useDocumentStore().error).toContain('Merriweather')
    expect(useDocumentStore().error).not.toBe('Could not export this PDF.')
  })

  it('returns the button to idle after a failure so the user can retry', async () => {
    save.mockRejectedValue(new Error('boom'))
    const w = mount(TopBar)
    await click(w)
    const button = w.get('[data-download]').element as HTMLButtonElement
    expect(button.disabled).toBe(false)
    // ...and a retry actually re-attempts.
    save.mockResolvedValue(new Uint8Array([9]))
    await click(w)
    expect(downloadBytes).toHaveBeenCalledTimes(1)
  })

  it('clears a previous failure when a retry starts', async () => {
    save.mockRejectedValue(new Error('boom'))
    const w = mount(TopBar)
    await click(w)
    expect(useDocumentStore().error).toBe('boom')
    save.mockResolvedValue(new Uint8Array([9]))
    await click(w)
    expect(useDocumentStore().error).toBe('')
  })

  it('falls back to a readable message for a non-Error rejection', async () => {
    save.mockRejectedValue('something odd')
    const w = mount(TopBar)
    await click(w)
    expect(useDocumentStore().error).toBe('Could not export this PDF.')
  })
})

describe('export progress', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.spyOn(exportFile, 'downloadBytes').mockImplementation(() => {})
    useEditsStore().reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p0'], { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
  })

  // A bar that flashes and vanishes on a 3-page document reads as a glitch.
  it('passes no progress callback for a small document', async () => {
    readyDoc(3)
    save.mockResolvedValue(new Uint8Array([1]))
    const w = mount(TopBar)
    await w.get('[data-download]').trigger('click')
    await flushPromises()
    expect(save.mock.calls[0]![2]).toBeUndefined()
  })

  it('passes a progress callback for a large document', async () => {
    readyDoc(40)
    save.mockResolvedValue(new Uint8Array([1]))
    const w = mount(TopBar)
    await w.get('[data-download]').trigger('click')
    await flushPromises()
    expect(typeof save.mock.calls[0]![2]).toBe('function')
  })

  it('shows a determinate count while exporting', async () => {
    readyDoc(40)
    let report: ((done: number, total: number) => void) | undefined
    save.mockImplementation((_d: unknown, _f: unknown, onProgress: never) => {
      report = onProgress
      return new Promise(() => {})
    })
    const w = mount(TopBar)
    await w.get('[data-download]').trigger('click')
    await flushPromises()
    report?.(7, 40)
    await flushPromises()
    expect(w.get('[data-download-label]').text()).toBe('Exporting 7 of 40')
  })
})

describe('withTimeout', () => {
  beforeEach(() => vi.useFakeTimers())

  it('resolves when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'too slow')).resolves.toBe('ok')
  })

  // The readiness handshake covers worker BOOT only; nothing else bounded
  // save, so a pathological document left the button spinning forever.
  it('rejects with a retryable message when it does not', async () => {
    const pending = withTimeout(new Promise(() => {}), 1000, 'too slow')
    const assertion = expect(pending).rejects.toThrow('too slow')
    await vi.advanceTimersByTimeAsync(1001)
    await assertion
  })

  it('does not leave a timer running after the promise settles', async () => {
    await withTimeout(Promise.resolve('ok'), 1000, 'too slow')
    expect(vi.getTimerCount()).toBe(0)
  })
})

// Phase 2 built a full history stack and, until Task 40, left it
// unreachable: nothing in the UI called undo(). These buttons are the
// non-keyboard path, which is the only path on the mobile shell.
describe('undo and redo controls', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    readyDoc(1)
    useEditsStore().reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p0'], { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
  })

  const rect: EditObject = {
    id: 'o1', pageId: 'p0', kind: 'rect',
    rect: { x: 0, y: 0, w: 10, h: 10 },
    rotation: 0, z: 1, locked: false, opacity: 1,
    stroke: [0, 0, 0], strokeWidth: 1, fill: null,
  }

  it('disables both with nothing to undo or redo', () => {
    const w = mount(TopBar)
    expect((w.get('[data-undo]').element as HTMLButtonElement).disabled).toBe(true)
    expect((w.get('[data-redo]').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('undoes the last op', async () => {
    const edits = useEditsStore()
    edits.applyOp({ type: 'addObject', object: rect }, 'Draw')
    const w = mount(TopBar)
    await w.get('[data-undo]').trigger('click')
    expect(Object.keys(edits.doc.objects)).toHaveLength(0)
  })

  it('redoes what it undid', async () => {
    const edits = useEditsStore()
    edits.applyOp({ type: 'addObject', object: rect }, 'Draw')
    const w = mount(TopBar)
    await w.get('[data-undo]').trigger('click')
    await w.get('[data-redo]').trigger('click')
    expect(Object.keys(edits.doc.objects)).toEqual(['o1'])
  })
})
