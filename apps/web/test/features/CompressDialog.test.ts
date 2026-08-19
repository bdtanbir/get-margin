import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import CompressDialog from '@/features/compress/CompressDialog.vue'
import { useEditsStore } from '@/stores/edits'
import * as exportFile from '@/lib/exportFile'
import type { CompressionResult, CompressionPreset, EditDocument } from '@margin/pdf-core'

const compress = vi.fn<
  (preset: CompressionPreset, editDoc?: EditDocument, fonts?: Map<string, Uint8Array>)
    => Promise<CompressionResult>
>()
vi.mock('@/workers/pdfClient', () => ({
  getPdfClient: () => ({ compress }),
  closeSharedDocument: vi.fn(),
}))
vi.mock('@/lib/fonts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fonts')>()
  return { ...actual, fontsForExport: vi.fn(async () => new Map()) }
})

const result = (over: Partial<CompressionResult> = {}): CompressionResult => ({
  bytes: new Uint8Array([1, 2, 3]),
  before: 4 * 1024 * 1024,
  after: 2 * 1024 * 1024,
  imagesRecompressed: 3,
  keptOriginal: false,
  ...over,
})

function seed() {
  const edits = useEditsStore()
  edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
    { p1: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null } })
}

async function estimate(w: ReturnType<typeof mount>) {
  await w.get('[data-compress-estimate]').trigger('click')
  await flushPromises()
}

describe('CompressDialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    compress.mockResolvedValue(result())
    vi.spyOn(exportFile, 'downloadBytes').mockImplementation(() => {})
    seed()
  })

  /**
   * The trade is quality for bytes and only the user knows which they
   * want, so the real numbers come first and downloading is a separate
   * decision.
   */
  it('shows nothing until it has measured', () => {
    const w = mount(CompressDialog)
    expect(w.find('[data-compress-result]').exists()).toBe(false)
    expect(w.find('[data-compress-download]').exists()).toBe(false)
  })

  it('reports the real before and after', async () => {
    const w = mount(CompressDialog)
    await estimate(w)
    const text = w.get('[data-compress-result]').text()
    expect(text).toContain('4.0 MB')
    expect(text).toContain('2.0 MB')
    expect(w.get('[data-compress-saved]').text()).toContain('50%')
  })

  it('offers the download only after measuring', async () => {
    const w = mount(CompressDialog)
    await estimate(w)
    expect(w.find('[data-compress-download]').exists()).toBe(true)
    await w.get('[data-compress-download]').trigger('click')
    expect(exportFile.downloadBytes).toHaveBeenCalledTimes(1)
  })

  it('measures the chosen preset', async () => {
    const w = mount(CompressDialog)
    await w.get('[data-preset="small"]').trigger('change')
    await estimate(w)
    expect(compress.mock.calls[0]![0]).toBe('small')
  })

  /**
   * Old numbers describing a different preset are the kind of small lie
   * that makes people distrust every other number in the app.
   */
  it('clears the measurement when the preset changes', async () => {
    const w = mount(CompressDialog)
    await estimate(w)
    expect(w.find('[data-compress-result]').exists()).toBe(true)
    await w.get('[data-preset="small"]').trigger('change')
    expect(w.find('[data-compress-result]').exists()).toBe(false)
  })

  /**
   * The honest outcome for a file that is already small. Reporting "0%
   * saved" would read as work done badly; saying it would get BIGGER says
   * what actually happened.
   */
  it('says a file cannot be improved rather than reporting 0%', async () => {
    compress.mockResolvedValue(result({ keptOriginal: true, after: 4 * 1024 * 1024 }))
    const w = mount(CompressDialog)
    await estimate(w)
    expect(w.get('[data-compress-kept]').text()).toMatch(/bigger/i)
    expect(w.get('[data-compress-download]').attributes('disabled')).toBeDefined()
  })

  it('explains a small saving on a document with no photographs', async () => {
    compress.mockResolvedValue(result({ imagesRecompressed: 0, after: 3.9 * 1024 * 1024 }))
    const w = mount(CompressDialog)
    await estimate(w)
    expect(w.get('[data-compress-result]').text()).toMatch(/No photographs were found/i)
  })

  // Setting expectations before the work, not after it.
  it('says up front that only photographs are affected', () => {
    expect(mount(CompressDialog).text()).toMatch(/Only photographs are affected/i)
  })

  it('reports a failure rather than offering a download', async () => {
    compress.mockRejectedValue(new Error('Compressing took too long'))
    const w = mount(CompressDialog)
    await estimate(w)
    expect(w.get('[data-compress-error]').text()).toMatch(/too long/)
    expect(w.find('[data-compress-download]').exists()).toBe(false)
  })

  it('offers three presets, gentle to aggressive', () => {
    expect(mount(CompressDialog).findAll('[data-preset]').map((p) => p.attributes('data-preset')))
      .toEqual(['light', 'balanced', 'small'])
  })
})
