import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import PageCanvas from '../../src/features/viewport/PageCanvas.vue'

const GEOM = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }
const page = { id: 'p1', sourceIndex: 0, geometry: GEOM }

function bitmap(w: number, h: number) {
  // page/scale are unused by every test below, but RenderResult requires
  // them — filled with harmless constants so this satisfies the type.
  return { width: w, height: h, rgba: new Uint8Array(w * h * 4).fill(255), page: 0, scale: 1 }
}

describe('PageCanvas', () => {
  it('sizes the element from pageViewSize, not the bitmap', () => {
    // The bitmap is at devicePixelRatio; CSS size must be the logical size.
    const w = mount(PageCanvas, { props: { page, zoom: 1, bitmap: bitmap(1224, 1584) } })
    const el = w.find('canvas').element as HTMLCanvasElement
    expect(el.style.width).toBe('612px')
    expect(el.style.height).toBe('792px')
  })

  it('sets the backing store to the bitmap dimensions', () => {
    const w = mount(PageCanvas, { props: { page, zoom: 1, bitmap: bitmap(1224, 1584) } })
    const el = w.find('canvas').element as HTMLCanvasElement
    expect(el.width).toBe(1224)
    expect(el.height).toBe(1584)
  })

  it('swaps CSS dimensions for a rotated page', () => {
    const rotated = { ...page, geometry: { ...GEOM, rotate: 90 as const } }
    const w = mount(PageCanvas, { props: { page: rotated, zoom: 1, bitmap: bitmap(792, 612) } })
    const el = w.find('canvas').element as HTMLCanvasElement
    expect(el.style.width).toBe('792px')
    expect(el.style.height).toBe('612px')
  })

  it('scales CSS size with zoom', () => {
    const w = mount(PageCanvas, { props: { page, zoom: 2, bitmap: bitmap(1224, 1584) } })
    expect((w.find('canvas').element as HTMLCanvasElement).style.width).toBe('1224px')
  })

  it('reserves correct space before the bitmap arrives', () => {
    // No layout shift when the render lands — the placeholder is already the right size.
    const w = mount(PageCanvas, { props: { page, zoom: 1 } })
    expect(w.attributes('style')).toContain('612px')
    expect(w.find('canvas').exists()).toBe(false)
  })

  it('exposes an accessible page label', () => {
    const w = mount(PageCanvas, { props: { page, zoom: 1, bitmap: bitmap(612, 792) } })
    expect(w.attributes('aria-label')).toMatch(/page 1/i)
  })

  it('paints the bitmap via putImageData', () => {
    const putImageData = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData } as never)
    mount(PageCanvas, { props: { page, zoom: 1, bitmap: bitmap(612, 792) } })
    expect(putImageData).toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
