import { describe, it, expect } from 'vitest'
import { snapOffset } from '@/features/overlay/snapOffset'
import type { Rails } from '@/features/overlay/alignmentRails'

/** A line 100pt wide starting at x 72, sitting on baseline 400. */
const line = { rect: { x: 72, y: 390, w: 100, h: 12 }, baseline: 400 }

const snap = (
  offset: { dx: number; dy: number },
  rails: Rails,
  tolerance = 6,
) => snapOffset({ ...line, offset, rails, tolerance })

const none: Rails = { xs: [], ys: [] }

/**
 * Pulling a dragged line onto one of the page's own rails.
 *
 * SOFT, and that is the feature. Sejda shows the rails and still lets you
 * put the line anywhere, which is right: the usual reason to move a line is
 * that it does not belong in any of the positions the document already
 * uses. A snap that could not be escaped would make the rails a cage.
 */
describe('snapOffset', () => {
  it('leaves the offset alone when there is nothing to snap to', () => {
    expect(snap({ dx: 30, dy: 40 }, none)).toEqual({ dx: 30, dy: 40 })
  })

  it('pulls the left edge onto a rail within reach', () => {
    // Left edge lands at 72 + 30 = 102; the rail is at 100.
    expect(snap({ dx: 30, dy: 0 }, { xs: [100], ys: [] }).dx).toBe(28)
  })

  it('pulls the right edge onto a rail, so columns can be aligned right', () => {
    // Right edge lands at 172 + 30 = 202; the rail is at 200.
    expect(snap({ dx: 30, dy: 0 }, { xs: [200], ys: [] }).dx).toBe(28)
  })

  it('takes the smaller correction when both edges are in reach', () => {
    // Left edge 102 is 2 from the rail at 100; right edge 202 is 5 from 197.
    expect(snap({ dx: 30, dy: 0 }, { xs: [100, 197], ys: [] }).dx).toBe(28)
  })

  it('takes the nearest of several rails in reach', () => {
    // Left edge at 102: 100 is 2 away, 105 is 3 away.
    expect(snap({ dx: 30, dy: 0 }, { xs: [100, 105], ys: [] }).dx).toBe(28)
  })

  /**
   * The property the user noticed in Sejda and asked about: the rails show,
   * and the line still goes wherever it is dropped.
   */
  it('does not snap to a rail out of reach', () => {
    expect(snap({ dx: 30, dy: 0 }, { xs: [80], ys: [] }).dx).toBe(30)
  })

  it('snaps exactly at the tolerance and not a hair beyond', () => {
    // Left edge 102, rail 96 -> 6 away, exactly the tolerance.
    expect(snap({ dx: 30, dy: 0 }, { xs: [96], ys: [] }, 6).dx).toBe(24)
    expect(snap({ dx: 30, dy: 0 }, { xs: [95.9], ys: [] }, 6).dx).toBe(30)
  })

  it('pulls the baseline onto a horizontal rail', () => {
    // Baseline lands at 400 + 50 = 450; the rail is at 452.
    expect(snap({ dx: 0, dy: 50 }, { xs: [], ys: [452] }).dy).toBe(52)
  })

  /** One axis snapping must not drag the other onto anything. */
  it('snaps the two axes independently', () => {
    const out = snap({ dx: 30, dy: 50 }, { xs: [100], ys: [] })
    expect(out).toEqual({ dx: 28, dy: 50 })
  })

  it('snaps both when both are in reach', () => {
    expect(snap({ dx: 30, dy: 50 }, { xs: [100], ys: [452] }))
      .toEqual({ dx: 28, dy: 52 })
  })

  /**
   * A tolerance of zero is how a caller turns snapping off -- at a very
   * high zoom the view-pixel threshold converts to almost nothing, and the
   * arithmetic has to survive that rather than snapping to whatever is
   * nearest.
   */
  it('snaps nothing at zero tolerance', () => {
    expect(snap({ dx: 30, dy: 50 }, { xs: [100], ys: [452] }, 0))
      .toEqual({ dx: 30, dy: 50 })
  })
})
