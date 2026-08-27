import type { Rails } from './alignmentRails'

/**
 * A dragged line pulled onto the page's own rails.
 *
 * SOFT, and deliberately so. The rails say where the document's columns and
 * baselines are; a line within a few pixels of one is almost certainly
 * meant to be on it, and a line further away is almost certainly not. A
 * snap that could not be escaped would turn the rails into a cage, and the
 * usual reason to move a line is that it does not belong in any of the
 * positions the document already uses.
 *
 * Pure, and separate from both the gesture that calls it and the component
 * that draws the rails, so the arithmetic can be tested on its own.
 */
export type SnapInput = {
  /** The line's box before the move, MuPDF page space. */
  rect: { x: number; y: number; w: number; h: number }
  /** The line's baseline before the move, same space. */
  baseline: number
  /** What the drag has produced so far, before snapping. */
  offset: { dx: number; dy: number }
  rails: Rails
  /**
   * How far a coordinate may sit from a rail and still be pulled onto it,
   * in POINTS. The caller converts from view pixels, so the threshold feels
   * the same at every zoom -- and shrinks to nothing when zoomed far in,
   * which is the right behaviour: someone working at 800% is placing
   * something precisely and does not want to be nudged.
   */
  tolerance: number
}

export function snapOffset(input: SnapInput): { dx: number; dy: number } {
  const { rect, baseline, offset, rails, tolerance } = input

  /**
   * Both edges are candidates, so a line can be aligned left OR right --
   * a figure caption lining up with the right edge of the column above it
   * is as ordinary as one lining up with the left.
   */
  const dx = correct(
    [rect.x + offset.dx, rect.x + rect.w + offset.dx],
    rails.xs,
    tolerance,
  )
  const dy = correct([baseline + offset.dy], rails.ys, tolerance)

  return { dx: offset.dx + dx, dy: offset.dy + dy }
}

/**
 * The smallest nudge that puts one of `positions` on one of `rails`, or
 * zero if none is close enough.
 *
 * Smallest rather than first: with two candidate edges and several rails
 * the user meant the alignment they were nearest to, and any other choice
 * makes the line jump past the rail under the cursor to reach a different
 * one.
 */
function correct(positions: number[], rails: number[], tolerance: number): number {
  let best = 0
  let bestDistance = Infinity
  for (const p of positions) {
    for (const rail of rails) {
      const delta = rail - p
      const distance = Math.abs(delta)
      // `<=` so a coordinate exactly at the tolerance snaps: the boundary
      // belongs to the rail, and a test pins which side of it does what.
      if (distance <= tolerance && distance < bestDistance) {
        best = delta
        bestDistance = distance
      }
    }
  }
  return best
}
