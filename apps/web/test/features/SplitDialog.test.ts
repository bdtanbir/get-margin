import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { unzipSync } from 'fflate'
import SplitDialog from '@/features/pages/SplitDialog.vue'
import { useDocumentStore } from '@/stores/document'
import { seedPages } from '../helpers/seedDocument'
import * as exportFile from '@/lib/exportFile'

const save = vi.fn()

vi.mock('@/workers/pdfClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/workers/pdfClient')>()
  return { ...actual, getPdfClient: () => ({ save }) }
})

vi.mock('@/lib/fonts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fonts')>()
  return { ...actual, fontsForExport: vi.fn(async () => new Map()) }
})

describe('SplitDialog', () => {
  let downloadBytes: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    seedPages(10)
    useDocumentStore().$patch({ fileName: 'contract.pdf' })
    // Distinct bytes per call so the zip's entries are distinguishable.
    let n = 0
    save.mockImplementation(async () => new Uint8Array([++n]))
    downloadBytes = vi.spyOn(exportFile, 'downloadBytes').mockImplementation(() => {})
  })

  async function withRange(range: string) {
    const w = mount(SplitDialog)
    await w.get('[data-split-input]').setValue(range)
    return w
  }

  it('previews how many files a range produces', async () => {
    const w = await withRange('1-3, 5')
    expect(w.get('[data-split-summary]').text()).toContain('2 files')
  })

  it('reports a bad range rather than previewing nonsense', async () => {
    const w = await withRange('99')
    expect(w.get('[data-split-summary]').text()).toContain('10 pages')
  })

  it('disables the action until the range parses', async () => {
    const w = mount(SplitDialog)
    expect((w.get('[data-split-run]').element as HTMLButtonElement).disabled).toBe(true)
    await w.get('[data-split-input]').setValue('1-2')
    expect((w.get('[data-split-run]').element as HTMLButtonElement).disabled).toBe(false)
  })

  // One range is an extract: a bare PDF, not a zip containing one file.
  it('downloads a single range as a plain PDF', async () => {
    const w = await withRange('2-4')
    await w.get('[data-split-run]').trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledTimes(1)
    expect(downloadBytes).toHaveBeenCalledTimes(1)
    expect(downloadBytes.mock.calls[0]![1]).toBe('contract-2-4.pdf')
  })

  // Several ranges ship as ONE download: browsers throttle successive
  // programmatic downloads, so a ten-way split would silently lose most.
  it('downloads several ranges as one zip', async () => {
    const w = await withRange('1-2, 4, 6-7')
    await w.get('[data-split-run]').trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledTimes(3)
    expect(downloadBytes).toHaveBeenCalledTimes(1)
    expect(downloadBytes.mock.calls[0]![1]).toBe('contract-split.zip')

    const archive = unzipSync(downloadBytes.mock.calls[0]![0] as Uint8Array)
    expect(Object.keys(archive).sort()).toEqual([
      'contract-1-2.pdf', 'contract-4.pdf', 'contract-6-7.pdf',
    ])
  })

  it('narrows pageOrder to the requested range for each part', async () => {
    const w = await withRange('1-2, 5')
    await w.get('[data-split-run]').trigger('click')
    await flushPromises()
    expect(save.mock.calls[0]![0].pageOrder).toEqual(['p0', 'p1'])
    expect(save.mock.calls[1]![0].pageOrder).toEqual(['p4'])
  })

  it('surfaces an export failure instead of downloading', async () => {
    save.mockRejectedValue(new Error('boom'))
    const w = await withRange('1-2')
    await w.get('[data-split-run]').trigger('click')
    await flushPromises()
    expect(downloadBytes).not.toHaveBeenCalled()
    expect(w.get('[data-split-error]').text()).toContain('boom')
  })

  it('closes after a successful split', async () => {
    const w = await withRange('1-2')
    await w.get('[data-split-run]').trigger('click')
    await flushPromises()
    expect(w.emitted('close')).toBeTruthy()
  })
})
