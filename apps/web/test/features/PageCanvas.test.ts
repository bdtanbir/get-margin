import { describe, it, expect, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import PageCanvas from '../../src/features/viewport/PageCanvas.vue'

const GEOM = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }
const page = { id: 'p1', sourceId: 'src-0', sourceIndex: 0, geometry: GEOM }

function bitmap(w: number, h: number) {
  // page/scale are unused by every test below, but RenderResult requires
  // them — filled with harmless constants so this satisfies the type.
  return { width: w, height: h, rgba: new Uint8Array(w * h * 4).fill(255), page: 0, scale: 1 }
}

describe('PageCanvas', () => {
  it('sizes the element from pageViewSize, not the bitmap', () => {
    // The bitmap is at devicePixelRatio; CSS size must be the logical size.
    const w = mount(PageCanvas, { props: { page, index: 0, zoom: 1, bitmap: bitmap(1224, 1584) } })
    const el = w.find('canvas').element as HTMLCanvasElement
    expect(el.style.width).toBe('612px')
    expect(el.style.height).toBe('792px')
  })

  it('sets the backing store to the bitmap dimensions', () => {
    const w = mount(PageCanvas, { props: { page, index: 0, zoom: 1, bitmap: bitmap(1224, 1584) } })
    const el = w.find('canvas').element as HTMLCanvasElement
    expect(el.width).toBe(1224)
    expect(el.height).toBe(1584)
  })

  it('swaps CSS dimensions for a rotated page', () => {
    const rotated = { ...page, geometry: { ...GEOM, rotate: 90 as const } }
    const w = mount(PageCanvas, { props: { page: rotated, index: 0, zoom: 1, bitmap: bitmap(792, 612) } })
    const el = w.find('canvas').element as HTMLCanvasElement
    expect(el.style.width).toBe('792px')
    expect(el.style.height).toBe('612px')
  })

  it('scales CSS size with zoom', () => {
    const w = mount(PageCanvas, { props: { page, index: 0, zoom: 2, bitmap: bitmap(1224, 1584) } })
    expect((w.find('canvas').element as HTMLCanvasElement).style.width).toBe('1224px')
  })

  it('reserves correct space before the bitmap arrives', () => {
    // No layout shift when the render lands — the placeholder is already the right size.
    const w = mount(PageCanvas, { props: { page, index: 0, zoom: 1 } })
    expect(w.attributes('style')).toContain('612px')
    expect(w.find('canvas').exists()).toBe(false)
  })

  it('exposes an accessible page label', () => {
    const w = mount(PageCanvas, { props: { page, index: 0, zoom: 1, bitmap: bitmap(612, 792) } })
    expect(w.attributes('aria-label')).toMatch(/page 1/i)
  })

  it('paints the bitmap via putImageData', () => {
    const putImageData = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData } as never)
    mount(PageCanvas, { props: { page, index: 0, zoom: 1, bitmap: bitmap(612, 792) } })
    expect(putImageData).toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  // Regression test for a real defect a Playwright e2e test caught (Task
  // 19): a bitmap arriving at DIFFERENT dimensions than the currently
  // mounted canvas (e.g. a placeholder-tier render replaced by a
  // full-tier one for a page that's already on screen) must repaint
  // AFTER the canvas element's own `:width`/`:height` attributes have
  // already been patched to the new size, not before. Getting the order
  // backwards is invisible here — jsdom's canvas has no real pixel
  // buffer, so it can't reproduce the browser's "resizing a canvas clears
  // its bitmap" behaviour that actually wipes a too-early paint — but the
  // ORDERING itself (does paint() see the new width/height, or the stale
  // one?) is a real, faithfully-reproduced DOM timing fact in jsdom, and
  // it's exactly what `flush: 'post'` vs the default `flush: 'pre'`
  // controls. This is why the fix needs both this test AND the e2e one:
  // this pins the mechanism precisely; the e2e test is what would have
  // caught the actual visible symptom (a permanently blank page).
  it('repaints after the canvas has been resized to the new bitmap, not before', async () => {
    const calls: Array<{ atMountWidth: number; atMountHeight: number; dataWidth: number; dataHeight: number }> = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const canvasEl = this
      return {
        putImageData(data: ImageData) {
          // Read the canvas element's OWN width/height live, at the exact
          // moment this paint call happens — not the bitmap's dimensions,
          // which is what would be wrongly equal to `data.width/height`
          // even under the buggy `flush: 'pre'` ordering.
          calls.push({
            atMountWidth: canvasEl.width,
            atMountHeight: canvasEl.height,
            dataWidth: data.width,
            dataHeight: data.height,
          })
        },
      } as unknown as CanvasRenderingContext2D
    })

    const w = mount(PageCanvas, { props: { page, index: 0, zoom: 1, bitmap: bitmap(612, 792) } })
    await w.setProps({ bitmap: bitmap(1224, 1584) }) // a genuinely different-sized bitmap
    await nextTick()

    const last = calls.at(-1)
    expect(last).toBeDefined()
    // The new bitmap's data was used...
    expect(last!.dataWidth).toBe(1224)
    expect(last!.dataHeight).toBe(1584)
    // ...and, critically, the canvas element itself had ALREADY been
    // resized to match by the time this paint ran. Under the old `pre`
    // flush timing this would observe the STALE 612x792 here instead —
    // see the perturbation in the Task 19 report.
    expect(last!.atMountWidth).toBe(1224)
    expect(last!.atMountHeight).toBe(1584)

    vi.restoreAllMocks()
  })
})
