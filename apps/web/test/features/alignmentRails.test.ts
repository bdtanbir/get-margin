import { describe, it, expect } from 'vitest'
import { alignmentRails } from '@/features/overlay/alignmentRails'
import type { PageQuadIndex } from '@margin/pdf-core'

/** A line's geometry is all these rails read; the rest is filler. */
const line = (x0: number, x1: number, baseline: number, text = 'ab') => ({
  bbox: [x0, baseline - 10, x1, baseline + 2] as [number, number, number, number],
  text,
  font: 'Helvetica',
  bold: false,
  italic: false,
  color: [0, 0, 0],
  size: 10,
  baseline,
  chars: [...text].map((char) => ({ char, quad: [x0, 0, x1, 0, x0, 0, x1, 0] })),
})

const index = (...lines: ReturnType<typeof line>[]): PageQuadIndex =>
  ({ lines }) as unknown as PageQuadIndex

/**
 * The rails a dragged line can be lined up against, taken from the page's
 * own layout rather than from a fixed grid.
 *
 * That is the whole idea: a uniform grid tells you where a notional lattice
 * is, which is never where the document's columns are. Left edges, right
 * edges and baselines are the three things a reader perceives as
 * "aligned", so those are the three the rails are built from.
 */
describe('alignmentRails', () => {
  it('takes a vertical rail from each line’s left and right edge', () => {
    expect(alignmentRails(index(line(72, 200, 100))).xs).toEqual([72, 200])
  })

  it('takes a horizontal rail from each line’s baseline', () => {
    expect(alignmentRails(index(line(72, 200, 100))).ys).toEqual([100])
  })

  /**
   * Text that looks flush is rarely flush to the micron. Without a quantum
   * a left margin shared by forty lines becomes forty rails a fraction of a
   * point apart, drawn as one thick fuzzy band.
   */
  it('merges coordinates too close to tell apart', () => {
    const rails = alignmentRails(index(
      line(72, 200, 100),
      line(72.2, 200.1, 100.3),
      line(71.9, 199.8, 99.8),
    ))
    expect(rails.xs).toHaveLength(2)
    expect(rails.xs[0]).toBeCloseTo(72, 1)
    expect(rails.xs[1]).toBeCloseTo(200, 1)
    expect(rails.ys).toHaveLength(1)
    expect(rails.ys[0]).toBeCloseTo(100, 1)
  })

  /**
   * The bug the first implementation had: rounding to a half-point grid
   * split 100.0 from 100.3 because they fall in different buckets, leaving
   * exactly the fuzzy double line the merging exists to prevent. Whether
   * two coordinates merge must depend on the gap between them.
   */
  it('merges across a boundary a grid would have split them on', () => {
    expect(alignmentRails(index(line(72, 200, 100), line(72, 200, 100.3))).ys)
      .toHaveLength(1)
  })

  /**
   * Otherwise a page of tightly-leaded text merges transitively into one
   * rail spanning the whole page.
   */
  it('does not let a chain of near-misses merge into one rail', () => {
    const rails = alignmentRails(index(
      line(72, 200, 100),
      line(72, 200, 100.4),
      line(72, 200, 100.8),
      line(72, 200, 101.2),
    ))
    expect(rails.ys.length).toBeGreaterThan(1)
  })

  it('keeps coordinates that are genuinely different', () => {
    expect(alignmentRails(index(line(72, 200, 100), line(90, 200, 130))).xs)
      .toEqual([72, 90, 200])
  })

  it('returns them in order, so the output does not depend on line order', () => {
    const a = alignmentRails(index(line(300, 400, 200), line(72, 200, 100)))
    const b = alignmentRails(index(line(72, 200, 100), line(300, 400, 200)))
    expect(a).toEqual(b)
    expect(a.xs).toEqual([...a.xs].sort((m, n) => m - n))
    expect(a.ys).toEqual([...a.ys].sort((m, n) => m - n))
  })

  /**
   * A line cannot be aligned to itself, and its own rails would sit under
   * the text being dragged -- reading as a snap target that is simply
   * wherever the line already was.
   */
  it('leaves out the line being moved', () => {
    const rails = alignmentRails(index(line(72, 200, 100), line(300, 400, 200)), { exclude: 0 })
    expect(rails.xs).toEqual([300, 400])
    expect(rails.ys).toEqual([200])
  })

  it('drops that line’s rails only, not one another line happens to share', () => {
    const rails = alignmentRails(index(line(72, 200, 100), line(72, 400, 200)), { exclude: 0 })
    expect(rails.xs).toEqual([72, 400])
  })

  it('ignores empty lines, which have no geometry to offer', () => {
    expect(alignmentRails(index(line(0, 0, 0, ''), line(72, 200, 100))))
      .toEqual({ xs: [72, 200], ys: [100] })
  })

  it('is empty for a page with no text', () => {
    expect(alignmentRails(index())).toEqual({ xs: [], ys: [] })
  })
})
