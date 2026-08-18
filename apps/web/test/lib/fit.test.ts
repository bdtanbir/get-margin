import { describe, it, expect } from 'vitest'
import { computeFitZoom, nextZoomStep, ZOOM_STEPS } from '../../src/lib/fit.js'

const LETTER = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }
const LANDSCAPE = { ...LETTER, rotate: 90 as const }

describe('computeFitZoom', () => {
  it('fits width using the container width minus padding', () => {
    const z = computeFitZoom({ mode: 'width', containerWidth: 712, containerHeight: 400, geometry: LETTER, padding: 50 })
    expect(z).toBeCloseTo(1, 5) // (712 - 2*50) / 612 ≈ 1.0
  })

  it('fits page to whichever axis is more constrained', () => {
    const z = computeFitZoom({ mode: 'page', containerWidth: 1224, containerHeight: 892, geometry: LETTER, padding: 50 })
    // height is the binding constraint: (892 - 100) / 792 ≈ 1.0
    expect(z).toBeCloseTo(1, 5)
  })

  it('returns exactly 1 for actual size', () => {
    expect(computeFitZoom({ mode: 'actual', containerWidth: 300, containerHeight: 300, geometry: LETTER })).toBe(1)
  })

  it('accounts for rotation when fitting', () => {
    // A 90-degree page is 792 wide, so fit-width gives a smaller zoom.
    const portrait = computeFitZoom({ mode: 'width', containerWidth: 712, containerHeight: 900, geometry: LETTER, padding: 50 })
    const landscape = computeFitZoom({ mode: 'width', containerWidth: 712, containerHeight: 900, geometry: LANDSCAPE, padding: 50 })
    expect(landscape).toBeLessThan(portrait)
  })

  it('clamps to the zoom range', () => {
    expect(computeFitZoom({ mode: 'width', containerWidth: 20, containerHeight: 20, geometry: LETTER })).toBeGreaterThanOrEqual(0.1)
    expect(computeFitZoom({ mode: 'width', containerWidth: 99999, containerHeight: 99999, geometry: LETTER })).toBeLessThanOrEqual(8)
  })

  it('survives a zero-sized container during first layout', () => {
    const z = computeFitZoom({ mode: 'width', containerWidth: 0, containerHeight: 0, geometry: LETTER })
    expect(Number.isFinite(z)).toBe(true)
    expect(z).toBeGreaterThan(0)
  })
})

describe('nextZoomStep', () => {
  it('steps up to the next preset', () => {
    expect(nextZoomStep(1, 1)).toBe(ZOOM_STEPS[ZOOM_STEPS.indexOf(1) + 1])
  })

  it('steps down to the previous preset', () => {
    expect(nextZoomStep(1, -1)).toBe(ZOOM_STEPS[ZOOM_STEPS.indexOf(1) - 1])
  })

  it('snaps an off-preset value to the neighbouring preset', () => {
    // 1.1 sits strictly between the 1 and 1.25 presets. An inequality-only
    // assertion here would pass even if this jumped straight to 8x instead
    // of the true neighbour, so pin the exact expected preset on each side.
    expect(nextZoomStep(1.1, 1)).toBe(1.25)
    expect(nextZoomStep(1.1, -1)).toBe(1)
  })

  it('saturates at both ends instead of wrapping', () => {
    const first = ZOOM_STEPS[0]!
    const last = ZOOM_STEPS[ZOOM_STEPS.length - 1]!
    expect(nextZoomStep(first, -1)).toBe(first)
    expect(nextZoomStep(last, 1)).toBe(last)
  })
})
