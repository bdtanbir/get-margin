import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import ImageExport from '@/features/export/ImageExport.vue'
import { useDocumentStore } from '@/stores/document'
import { seedPages } from '../helpers/seedDocument'
import * as exportFile from '@/lib/exportFile'
import type { RasterFormat, RasterisedPage } from '@margin/pdf-core'

const rasterise =
  vi.fn<(page: number, dpi: number, format?: RasterFormat, quality?: number) => Promise<RasterisedPage>>()
const rasterSize = vi.fn<(page: number, dpi: number) => Promise<{ width: number; height: number }>>()

vi.mock('@/workers/pdfClient', () => ({
  getPdfClient: () => ({ rasterise, rasterSize }),
  closeSharedDocument: vi.fn(),
}))

/** The zip helper is real elsewhere; here we only care that it was reached. */
const zipFiles = vi.fn<(entries: Array<{ name: string; data: Uint8Array }>) => Promise<Uint8Array>>(
  async () => new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
)
vi.mock('@/lib/zip', () => ({ zipFiles: (entries: Array<{ name: string; data: Uint8Array }>) => zipFiles(entries) }))

const jpegOf = (page: number): RasterisedPage => ({
  // A real SOI so a careless assertion on the bytes still means something.
  bytes: new Uint8Array([0xff, 0xd8, 0xff, page]),
  width: 1275,
  height: 1650,
  format: 'jpeg',
})

function seed(pageCount = 3) {
  seedPages(pageCount)
  useDocumentStore().$patch({ fileName: 'report.pdf' })
}

let downloadBytes: ReturnType<typeof vi.spyOn>

describe('ImageExport', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    rasterise.mockImplementation(async (page) => jpegOf(page))
    rasterSize.mockResolvedValue({ width: 1275, height: 1650 })
    downloadBytes = vi.spyOn(exportFile, 'downloadBytes').mockImplementation(() => {})
    seed()
  })

  /**
   * The whole reason this feature is not a job: nothing leaves the device.
   *
   * Every other conversion in the product uploads and asks first, so a user
   * who has seen that dialog will assume this is the same unless it says
   * otherwise. The copy is the feature, so it is asserted like one.
   */
  it('states that nothing is uploaded, without a consent step', async () => {
    const w = mount(ImageExport)
    await flushPromises()
    const privacy = w.get('[data-image-privacy]').text()
    expect(privacy).toMatch(/on your device/i)
    expect(privacy).toMatch(/nothing is uploaded/i)
    // And there is no consent gate to tick: Export is live immediately.
    expect(w.get('[data-image-run]').attributes('disabled')).toBeUndefined()
  })

  it('exports one page as a single image rather than a zip of one', async () => {
    const w = mount(ImageExport)
    await w.get('[data-image-range]').setValue('2')
    await flushPromises()
    await w.get('[data-image-run]').trigger('click')
    await flushPromises()

    expect(rasterise).toHaveBeenCalledTimes(1)
    // Zero-based on the way in, one-based on the way out.
    expect(rasterise).toHaveBeenCalledWith(1, 150, 'jpeg')
    expect(zipFiles).not.toHaveBeenCalled()
    expect(downloadBytes).toHaveBeenCalledWith(expect.any(Uint8Array), 'report-p2.jpg', 'image/jpeg')
  })

  it('exports every page when no range is given', async () => {
    const w = mount(ImageExport)
    await flushPromises()
    await w.get('[data-image-run]').trigger('click')
    await flushPromises()

    expect(rasterise).toHaveBeenCalledTimes(3)
    expect(rasterise.mock.calls.map((c) => c[0])).toEqual([0, 1, 2])
  })

  /**
   * One download, not N. Browsers throttle successive programmatic
   * downloads, so several files must arrive as a single zip or most of them
   * silently do not arrive at all.
   */
  it('bundles several pages into one zip', async () => {
    const w = mount(ImageExport)
    await w.get('[data-image-range]').setValue('1-3')
    await flushPromises()
    await w.get('[data-image-run]').trigger('click')
    await flushPromises()

    expect(zipFiles).toHaveBeenCalledTimes(1)
    const entries = zipFiles.mock.calls[0]![0]
    expect(entries.map((e) => e.name)).toEqual(['report-p1.jpg', 'report-p2.jpg', 'report-p3.jpg'])
    expect(downloadBytes).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'report-images.zip',
      'application/zip',
    )
  })

  it('exports the pages a range names, and no others', async () => {
    const w = mount(ImageExport)
    await w.get('[data-image-range]').setValue('1, 3')
    await flushPromises()
    await w.get('[data-image-run]').trigger('click')
    await flushPromises()

    expect(rasterise.mock.calls.map((c) => c[0])).toEqual([0, 2])
  })

  it('changes the DPI it asks for', async () => {
    const w = mount(ImageExport)
    await w.get('[data-image-dpi="300"]').trigger('change')
    await w.get('[data-image-range]').setValue('1')
    await flushPromises()
    await w.get('[data-image-run]').trigger('click')
    await flushPromises()

    expect(rasterise).toHaveBeenCalledWith(0, 300, 'jpeg')
  })

  it('exports PNG when PNG is chosen, with the right name and type', async () => {
    const w = mount(ImageExport)
    await w.get('[data-image-format="png"]').trigger('change')
    await w.get('[data-image-range]').setValue('1')
    await flushPromises()
    await w.get('[data-image-run]').trigger('click')
    await flushPromises()

    expect(rasterise).toHaveBeenCalledWith(0, 150, 'png')
    expect(downloadBytes).toHaveBeenCalledWith(expect.any(Uint8Array), 'report-p1.png', 'image/png')
  })

  /** The number is the point: 300 DPI on A4 is a download worth knowing about first. */
  it('shows the pixel dimensions before exporting anything', async () => {
    rasterSize.mockResolvedValue({ width: 2550, height: 3300 })
    const w = mount(ImageExport)
    await flushPromises()
    expect(w.get('[data-image-summary]').text()).toContain('2550 × 3300 px')
    expect(rasterise).not.toHaveBeenCalled()
  })

  it('says how many files are coming, and that several arrive as a zip', async () => {
    const w = mount(ImageExport)
    await flushPromises()
    expect(w.get('[data-image-summary]').text()).toContain('3 images, as a zip')

    await w.get('[data-image-range]').setValue('2')
    await flushPromises()
    expect(w.get('[data-image-summary]').text()).toContain('1 image')
  })

  it('explains a bad range instead of exporting something arbitrary', async () => {
    const w = mount(ImageExport)
    await w.get('[data-image-range]').setValue('nonsense')
    await flushPromises()

    expect(w.get('[data-image-range-error]').text()).toBeTruthy()
    expect(w.get('[data-image-run]').attributes('disabled')).toBeDefined()
    expect(rasterise).not.toHaveBeenCalled()
  })

  it('reports a failure rather than closing as though it worked', async () => {
    rasterise.mockRejectedValue(new Error('That page could not be rendered.'))
    const w = mount(ImageExport)
    await w.get('[data-image-range]').setValue('1')
    await flushPromises()
    await w.get('[data-image-run]').trigger('click')
    await flushPromises()

    expect(w.get('[data-image-error]').text()).toBe('That page could not be rendered.')
    expect(downloadBytes).not.toHaveBeenCalled()
    expect(w.emitted('close')).toBeUndefined()
  })

  it('closes after a successful export', async () => {
    const w = mount(ImageExport)
    await w.get('[data-image-range]').setValue('1')
    await flushPromises()
    await w.get('[data-image-run]').trigger('click')
    await flushPromises()
    expect(w.emitted('close')).toBeTruthy()
  })

  it('cancels without exporting anything', async () => {
    const w = mount(ImageExport)
    await flushPromises()
    await w.get('[data-image-cancel]').trigger('click')
    expect(rasterise).not.toHaveBeenCalled()
    expect(w.emitted('close')).toBeTruthy()
  })
})

describe('imageFileName', () => {
  /** So a folder of exports sorts p01…p10 rather than p1, p10, p2. */
  it('pads the page number to the width of the largest', () => {
    expect(exportFile.imageFileName('report.pdf', 3, 'jpeg', 12)).toBe('report-p03.jpg')
    expect(exportFile.imageFileName('report.pdf', 12, 'jpeg', 12)).toBe('report-p12.jpg')
    expect(exportFile.imageFileName('report.pdf', 3, 'jpeg', 9)).toBe('report-p3.jpg')
  })

  it('uses the right extension and copes with an odd source name', () => {
    expect(exportFile.imageFileName('a.PDF', 1, 'png')).toBe('a-p1.png')
    expect(exportFile.imageFileName('no-extension', 1, 'jpeg')).toBe('no-extension-p1.jpg')
  })
})
