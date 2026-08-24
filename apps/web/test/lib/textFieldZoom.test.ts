import { describe, it, expect } from 'vitest'
import { noZoomTextSize, IOS_MIN_FONT_PX } from '@/lib/textFieldZoom'

describe('noZoomTextSize', () => {
  it('leaves text that is already large enough alone', () => {
    const { fontSize, scale } = noZoomTextSize(24)

    expect(fontSize).toBe(24)
    expect(scale).toBe(1)
  })

  it('does not touch text exactly at the threshold', () => {
    const { fontSize, scale } = noZoomTextSize(IOS_MIN_FONT_PX)

    expect(fontSize).toBe(IOS_MIN_FONT_PX)
    expect(scale).toBe(1)
  })

  it('raises small text to the threshold so iOS has no reason to zoom', () => {
    expect(noZoomTextSize(9).fontSize).toBe(IOS_MIN_FONT_PX)
    expect(noZoomTextSize(15.9).fontSize).toBe(IOS_MIN_FONT_PX)
  })

  /**
   * The whole point: the field must still LOOK the size the document says.
   * Raising the font without scaling back would draw 9pt text at 16px and
   * the replacement would no longer match the line it replaces.
   */
  it('scales back by exactly what it raised, so the drawn size is unchanged', () => {
    for (const desired of [1, 4, 9, 12, 15.9, 16, 30]) {
      const { fontSize, scale } = noZoomTextSize(desired)
      expect(fontSize * scale).toBeCloseTo(desired, 6)
    }
  })

  it('never scales up, only down', () => {
    for (const desired of [1, 9, 16, 40]) {
      expect(noZoomTextSize(desired).scale).toBeLessThanOrEqual(1)
    }
  })

  /**
   * A zero or negative size is not a real request -- a page that has not
   * been measured yet, or a degenerate line. Returning scale 0 would
   * collapse the field to nothing and leave the user with an invisible
   * caret rather than a small one.
   */
  it('refuses to collapse the field when handed a nonsense size', () => {
    for (const nonsense of [0, -5, Number.NaN]) {
      const { fontSize, scale } = noZoomTextSize(nonsense)
      expect(fontSize).toBeGreaterThanOrEqual(IOS_MIN_FONT_PX)
      expect(scale).toBeGreaterThan(0)
    }
  })
})
