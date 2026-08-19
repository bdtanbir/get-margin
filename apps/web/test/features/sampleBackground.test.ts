import { describe, it, expect } from 'vitest'
import { sampleBackground, CONFIDENT_ENOUGH, type Bitmap } from '@/features/patch/sampleBackground'

/** A bitmap painted by a function of x and y. */
function paint(
  width: number,
  height: number,
  at: (x: number, y: number) => [number, number, number],
): Bitmap {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = at(x, y)
      const i = (y * width + x) * 4
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255
    }
  }
  return { width, height, rgba }
}

const solid = (w: number, h: number, c: [number, number, number]): Bitmap => paint(w, h, () => c)

/** A line of text sitting in the middle of a 200x100 bitmap. */
const LINE = { x: 40, y: 40, w: 120, h: 18 }

describe('sampleBackground', () => {
  it('finds a white background', () => {
    const s = sampleBackground(solid(200, 100, [255, 255, 255]), LINE, 1)
    expect(s.color).toEqual([1, 1, 1])
    expect(s.confidence).toBe(1)
  })

  it('finds a coloured background', () => {
    const s = sampleBackground(solid(200, 100, [255, 240, 200]), LINE, 1)
    expect(s.color[0]).toBeCloseTo(1, 2)
    expect(s.color[1]).toBeCloseTo(240 / 255, 2)
    expect(s.color[2]).toBeCloseTo(200 / 255, 2)
    expect(s.confidence).toBeGreaterThan(CONFIDENT_ENOUGH)
  })

  /**
   * Inside the line is mostly glyphs, so an average taken there blends ink
   * with paper -- on black-on-white text that produces GREY, and covering
   * with grey is worse than not covering at all.
   */
  it('ignores the text itself, sampling around the line rather than through it', () => {
    const page = paint(200, 100, (x, y) => {
      const insideLine = y >= 40 && y < 58 && x >= 40 && x < 160
      // Dense black text filling the line's box.
      return insideLine ? [0, 0, 0] : [255, 255, 255]
    })
    const s = sampleBackground(page, LINE, 1)
    expect(s.color).toEqual([1, 1, 1])
    expect(s.confidence).toBeGreaterThan(CONFIDENT_ENOUGH)
  })

  /**
   * A rule, a border, or a descender poking into the band drags a MEAN
   * away from the paper colour. A median ignores a minority of outliers,
   * which is exactly what those are.
   */
  it('is not fooled by a rule running under the line', () => {
    const page = paint(200, 100, (_x, y) => (y === 60 ? [0, 0, 0] : [255, 255, 255]))
    const s = sampleBackground(page, LINE, 1)
    expect(s.color).toEqual([1, 1, 1])
  })

  it('scales the box into bitmap pixels', () => {
    // The bitmap is 2x, so the line's box in points covers twice as many
    // pixels -- sampling at 1x would read the wrong region entirely.
    const page = paint(400, 200, (_x, y) => (y < 120 ? [255, 255, 255] : [0, 0, 255]))
    const top = sampleBackground(page, { x: 20, y: 20, w: 60, h: 9 }, 2)
    expect(top.color).toEqual([1, 1, 1])
  })
})

/**
 * The confidence figure is the whole reason this is not just "read one
 * pixel". If it cannot tell a flat page from a photograph it is
 * decorative, and the warning built on it is noise.
 */
describe('confidence', () => {
  it('is high for a flat page', () => {
    expect(sampleBackground(solid(200, 100, [250, 250, 250]), LINE, 1).confidence)
      .toBeGreaterThan(CONFIDENT_ENOUGH)
  })

  it('is low for a gradient', () => {
    const page = paint(200, 100, (x) => [Math.round((x / 200) * 255), 128, 128])
    expect(sampleBackground(page, LINE, 1).confidence).toBeLessThan(CONFIDENT_ENOUGH)
  })

  it('is low for a photograph', () => {
    let seed = 7
    const page = paint(200, 100, () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      const v = (seed >> 8) & 0xff
      return [v, (v * 3) % 256, (v * 7) % 256]
    })
    expect(sampleBackground(page, LINE, 1).confidence).toBeLessThan(CONFIDENT_ENOUGH)
  })

  it('is low for a line straddling two blocks of colour', () => {
    const page = paint(200, 100, (x) => (x < 100 ? [255, 255, 255] : [0, 0, 0]))
    expect(sampleBackground(page, LINE, 1).confidence).toBeLessThan(CONFIDENT_ENOUGH)
  })

  it('tolerates the slight noise of antialiasing', () => {
    const page = paint(200, 100, (x, y) => {
      const jitter = ((x * 7 + y * 13) % 5) - 2
      const v = 250 + jitter
      return [v, v, v]
    })
    expect(sampleBackground(page, LINE, 1).confidence).toBeGreaterThan(CONFIDENT_ENOUGH)
  })
})

describe('when there is nothing to sample', () => {
  // A page not yet rendered. White is the honest default, and zero
  // confidence is what stops the UI presenting a guess as a measurement.
  it('reports no confidence rather than inventing one', () => {
    const s = sampleBackground(undefined, LINE, 1)
    expect(s.color).toEqual([1, 1, 1])
    expect(s.confidence).toBe(0)
    expect(s.samples).toBe(0)
  })

  it('handles an empty bitmap', () => {
    expect(sampleBackground({ width: 0, height: 0, rgba: new Uint8Array() }, LINE, 1).samples)
      .toBe(0)
  })

  it('handles a line entirely outside the bitmap', () => {
    const s = sampleBackground(solid(50, 50, [255, 255, 255]), { x: 500, y: 500, w: 10, h: 10 }, 1)
    expect(s.samples).toBe(0)
    expect(s.confidence).toBe(0)
  })

  it('reports how many pixels it used, so a thin sample is visible', () => {
    expect(sampleBackground(solid(200, 100, [255, 255, 255]), LINE, 1).samples)
      .toBeGreaterThan(100)
  })
})
