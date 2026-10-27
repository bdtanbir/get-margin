import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { TextPatchObject } from '@margin/pdf-core'
import TextPatchObjectView from '@/features/overlay/objects/TextPatchObject.vue'

/**
 * Reported: editing a Turnitin heading that sat on the bottom edge of the
 * page's logo cut the logo in half, on screen and in the download -- the
 * patch was an opaque box. The export now takes the line off the page, and
 * the preview shows the page as it looks without it.
 */

const renderWithoutLines = vi.fn()
vi.mock('@/workers/pdfClient', () => ({
  getPdfClient: () => ({ renderWithoutLines }),
  closeSharedDocument: vi.fn(),
}))

const patch: TextPatchObject = {
  id: 'x1', pageId: 'p1', kind: 'textPatch',
  lineIndex: 2, originalHash: 'abcd1234', originalText: 'Original', text: 'Replacement',
  fontFamily: 'Inter', fontSize: 12, baseline: 114, color: [0, 0, 0],
  background: [1, 1, 1], backgroundConfidence: 1, fit: 'overflow',
  rect: { x: 40, y: 100, w: 120, h: 18 },
  rotation: 0, z: 1, locked: false, opacity: 1,
}

const picture = (removed: number[]) => ({ width: 6, height: 3, rgba: new Uint8Array(6 * 3 * 4), removed })

const mountIt = (props: Record<string, unknown> = {}) => mount(TextPatchObjectView, {
  props: { object: patch, sourceId: 'src-0', sourceIndex: 4, lines: [2, 7], ...props },
})

beforeEach(() => {
  renderWithoutLines.mockReset()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData: vi.fn() } as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) { cb(new Blob(['x'])) })
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:without')
  globalThis.URL.revokeObjectURL = vi.fn()
  if (typeof globalThis.ImageData === 'undefined') {
    (globalThis as { ImageData?: unknown }).ImageData = class { constructor(public data: unknown, public width: number, public height: number) {} }
  }
})
afterEach(() => vi.restoreAllMocks())

describe('a text patch on screen', () => {
  it('shows the page without its patched lines instead of a box', async () => {
    renderWithoutLines.mockResolvedValue(picture([2, 7]))
    const w = mountIt()
    await flushPromises()
    // Every patched line on the page, so neighbours do not show each other's old text.
    expect(renderWithoutLines).toHaveBeenCalledWith('src-0', 4, [2, 7], expect.any(Object), expect.any(Number))
    expect(w.find('[data-patch-without]').attributes('href')).toBe('blob:without')
    expect(w.find('rect').exists()).toBe(false)
  })

  it('keeps the box when the line could not be removed, as the export does', async () => {
    renderWithoutLines.mockResolvedValue(picture([7]))
    const w = mountIt()
    await flushPromises()
    expect(w.find('[data-patch-without]').exists()).toBe(false)
    expect(w.find('rect').exists()).toBe(true)
  })

  it('keeps the box when the page cannot be rendered', async () => {
    renderWithoutLines.mockResolvedValue(null)
    const w = mountIt()
    await flushPromises()
    expect(w.find('rect').exists()).toBe(true)
  })

  it('asks for the area the box covered, a little wider than the line', async () => {
    renderWithoutLines.mockResolvedValue(picture([2]))
    mountIt()
    await flushPromises()
    const area = renderWithoutLines.mock.calls[0]![3] as { x: number; y: number; w: number; h: number }
    expect(area.x).toBeLessThan(40)
    expect(area.y).toBeLessThan(100)
    expect(area.x + area.w).toBeGreaterThan(160)
    expect(area.y + area.h).toBeGreaterThan(118)
  })
})
