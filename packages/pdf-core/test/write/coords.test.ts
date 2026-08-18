import { describe, it, expect } from 'vitest'
import type { PageGeometry } from '@margin/transform'
import { toAnnotSpace, toContentSpace } from '../../src/write/coords.js'

const letter: PageGeometry = { cropBox: [0, 0, 612, 792], rotate: 0 }
const offset: PageGeometry = { cropBox: [20, 30, 632, 822], rotate: 0 }
const turned: PageGeometry = { cropBox: [0, 0, 612, 792], rotate: 90 }

describe('toContentSpace', () => {
  it('is the identity — content streams already use raw PDF user space', () => {
    const r = { x: 100, y: 200, w: 50, h: 30 }
    expect(toContentSpace(r)).toEqual(r)
  })
})

describe('toAnnotSpace', () => {
  it('flips y for an origin-zero page', () => {
    // PDF rect y=200..230 on a 792pt-tall page is page-space y=562..592.
    expect(toAnnotSpace({ x: 100, y: 200, w: 50, h: 30 }, letter))
      .toEqual([100, 562, 150, 592])
  })

  it('subtracts a non-zero CropBox origin', () => {
    // MuPDF normalises the CropBox origin to (0,0), so callers must not
    // re-add it. x: 100-20 = 80. y: 822-230 = 592 measured from the top.
    expect(toAnnotSpace({ x: 100, y: 200, w: 50, h: 30 }, offset))
      .toEqual([80, 592, 130, 622])
  })

  it('applies page rotation', () => {
    const [x0, y0, x1, y1] = toAnnotSpace({ x: 100, y: 200, w: 50, h: 30 }, turned)
    // A quarter-turned page swaps the displayed extent: 792 wide, 612 tall.
    expect(x1).toBeLessThanOrEqual(792)
    expect(y1).toBeLessThanOrEqual(612)
    expect(x1 - x0).toBeCloseTo(30, 6)
    expect(y1 - y0).toBeCloseTo(50, 6)
  })

  it('always returns x0<x1 and y0<y1', () => {
    for (const g of [letter, offset, turned]) {
      const [x0, y0, x1, y1] = toAnnotSpace({ x: 10, y: 10, w: 40, h: 20 }, g)
      expect(x1).toBeGreaterThan(x0)
      expect(y1).toBeGreaterThan(y0)
    }
  })
})
