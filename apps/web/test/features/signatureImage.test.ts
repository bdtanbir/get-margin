import { describe, it, expect, vi } from 'vitest'
import { strokeOutline, fillStroke, inkBounds } from '@/features/signature/signatureImage'

describe('strokeOutline', () => {
  const line = (n: number): number[] => {
    const flat: number[] = []
    for (let i = 0; i < n; i++) flat.push(i * 10, 50)
    return flat
  }

  // The point of perfect-freehand: a closed variable-width OUTLINE, not the
  // input polyline. A signature drawn with a constant-width pen reads as a
  // drawn line rather than a signature.
  it('returns a closed outline with more points than the input', () => {
    const outline = strokeOutline(line(6))
    expect(outline.length).toBeGreaterThan(6)
    for (const p of outline) expect(p).toHaveLength(2)
  })

  it('varies in width along the stroke rather than being uniform', () => {
    const outline = strokeOutline(line(12))
    const ys = outline.map((p) => p[1]!)
    // A constant-width stroke would produce exactly two distinct y values.
    expect(new Set(ys.map((y) => Math.round(y))).size).toBeGreaterThan(2)
  })

  it('survives a stroke too short to have direction', () => {
    expect(() => strokeOutline([10, 10])).not.toThrow()
  })

  it('returns nothing usable for an empty stroke', () => {
    expect(strokeOutline([]).length).toBeLessThan(3)
  })
})

describe('fillStroke', () => {
  const ctx = () => ({
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(),
  })

  it('fills a polygon rather than stroking a path', () => {
    const c = ctx()
    fillStroke(c as unknown as CanvasRenderingContext2D, [0, 0, 10, 0, 20, 5, 30, 5])
    expect(c.fill).toHaveBeenCalledTimes(1)
    expect(c.closePath).toHaveBeenCalledTimes(1)
    expect(c.lineTo.mock.calls.length).toBeGreaterThan(2)
  })

  it('draws nothing for a degenerate stroke', () => {
    const c = ctx()
    fillStroke(c as unknown as CanvasRenderingContext2D, [])
    expect(c.fill).not.toHaveBeenCalled()
  })
})

describe('inkBounds', () => {
  /** width x height of alpha values, row-major. */
  function img(width: number, height: number, alpha: (x: number, y: number) => number): ImageData {
    const data = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) data[(y * width + x) * 4 + 3] = alpha(x, y)
    }
    return { data, width, height, colorSpace: 'srgb' } as ImageData
  }

  // Without cropping, a signature drawn in the corner of the pad places a
  // mostly-empty box whose handles are nowhere near the marks.
  it('hugs the inked region', () => {
    expect(inkBounds(img(10, 10, (x, y) => (x >= 2 && x <= 5 && y >= 3 && y <= 7 ? 255 : 0))))
      .toEqual({ x: 2, y: 3, w: 4, h: 5 })
  })

  it('returns undefined when nothing is inked', () => {
    expect(inkBounds(img(10, 10, () => 0))).toBeUndefined()
  })

  it('ignores all-but-transparent pixels', () => {
    expect(inkBounds(img(10, 10, () => 4))).toBeUndefined()
  })
})
