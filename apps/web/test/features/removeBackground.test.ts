import { describe, it, expect } from 'vitest'
import {
  removeBackground, OPAQUE_BELOW, TRANSPARENT_ABOVE,
} from '@/features/signature/removeBackground'

/** An ImageData-shaped object; jsdom has no ImageData constructor by default. */
function imageDataOf(pixels: Array<[number, number, number]>): ImageData {
  const data = new Uint8ClampedArray(pixels.length * 4)
  pixels.forEach(([r, g, b], i) => {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255
  })
  return { data, width: pixels.length, height: 1, colorSpace: 'srgb' } as ImageData
}

const alphaOf = (img: ImageData, i: number): number => img.data[i * 4 + 3]!

describe('removeBackground', () => {
  it('makes near-white pixels fully transparent', () => {
    const out = removeBackground(imageDataOf([[250, 250, 250], [10, 10, 10]]))
    expect(alphaOf(out, 0)).toBe(0)
    expect(alphaOf(out, 1)).toBe(255)
  })

  // A hard cut leaves visibly jagged, aliased stroke edges -- the thing that
  // makes a cut-out signature look pasted on.
  it('ramps alpha across the threshold rather than hard-clipping', () => {
    const out = removeBackground(imageDataOf([[200, 200, 200]]))
    expect(alphaOf(out, 0)).toBeGreaterThan(0)
    expect(alphaOf(out, 0)).toBeLessThan(255)
  })

  it('ramps monotonically from opaque to transparent', () => {
    const steps: Array<[number, number, number]> = []
    for (let v = OPAQUE_BELOW; v <= TRANSPARENT_ABOVE; v += 10) steps.push([v, v, v])
    const out = removeBackground(imageDataOf(steps))
    for (let i = 1; i < steps.length; i++) {
      expect(alphaOf(out, i)).toBeLessThanOrEqual(alphaOf(out, i - 1))
    }
  })

  // A signature photographed in poor light is all mid-to-dark grey. Eroding
  // it would erase the signature itself.
  it('leaves a dark photo untouched rather than erasing the signature', () => {
    const out = removeBackground(imageDataOf([[40, 40, 40], [30, 30, 30]]))
    expect(alphaOf(out, 0)).toBe(255)
    expect(alphaOf(out, 1)).toBe(255)
  })

  // A flat (r+g+b)/3 average would treat these two identically -- both are
  // one channel at full strength. Perceptual luminance does not: blue
  // weighs 0.0722 and green 0.7152, so blue ink survives intact while green
  // is mostly erased as background.
  it('uses perceptual luminance, not a flat channel average', () => {
    const out = removeBackground(imageDataOf([[0, 0, 255], [0, 255, 0]]))
    expect(alphaOf(out, 0)).toBe(255)
    expect(alphaOf(out, 1)).toBeLessThan(128)
    expect(alphaOf(out, 1)).toBeGreaterThan(0)
  })

  // Running it twice must not erode further -- the Draw tab's own output is
  // already transparent, and the Upload tab may re-run it on a preview.
  it('is idempotent', () => {
    const once = removeBackground(imageDataOf([[250, 250, 250], [200, 200, 200], [10, 10, 10]]))
    const alphas = [0, 1, 2].map((i) => alphaOf(once, i))
    const twice = removeBackground(once)
    expect([0, 1, 2].map((i) => alphaOf(twice, i))).toEqual(alphas)
  })
})
