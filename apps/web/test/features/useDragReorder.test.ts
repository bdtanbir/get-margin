import { describe, it, expect } from 'vitest'
import { moveTo, dropIndexFor } from '@/features/pages/useDragReorder'

describe('moveTo', () => {
  const order = ['a', 'b', 'c', 'd']

  it('moves an item forward', () => {
    expect(moveTo(order, 'a', 2)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves an item backward', () => {
    expect(moveTo(order, 'd', 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('moves to the very start and the very end', () => {
    expect(moveTo(order, 'c', 0)).toEqual(['c', 'a', 'b', 'd'])
    expect(moveTo(order, 'a', 3)).toEqual(['b', 'c', 'd', 'a'])
  })

  // Returning the SAME array is what stops a no-op drag creating an undo step.
  it('returns the original array when nothing moves', () => {
    expect(moveTo(order, 'b', 1)).toBe(order)
  })

  it('clamps an index past the end', () => {
    expect(moveTo(order, 'a', 99)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('clamps a negative index', () => {
    expect(moveTo(order, 'd', -5)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('leaves the order alone for an unknown id', () => {
    expect(moveTo(order, 'zz', 0)).toBe(order)
  })

  // The invariant that matters: reordering never loses or duplicates a page.
  it('never changes the length or loses an item, for any move', () => {
    for (let i = 0; i <= order.length; i++) {
      for (const id of order) {
        const out = moveTo(order, id, i)
        expect(out).toHaveLength(order.length)
        expect([...out].sort()).toEqual([...order].sort())
      }
    }
  })

  it('handles a single-page document', () => {
    expect(moveTo(['a'], 'a', 0)).toEqual(['a'])
  })
})

describe('dropIndexFor', () => {
  // Tiles at y 0-100, 100-200, 200-300 -> midpoints 50, 150, 250.
  const mids = [50, 150, 250]

  it('drops before the first tile when above its midpoint', () => {
    expect(dropIndexFor(mids, 10)).toBe(0)
  })

  it('drops between two tiles', () => {
    expect(dropIndexFor(mids, 120)).toBe(1)
    expect(dropIndexFor(mids, 220)).toBe(2)
  })

  it('drops at the end when below every midpoint', () => {
    expect(dropIndexFor(mids, 999)).toBe(3)
  })

  it('is exclusive at the midpoint itself, so a hover does not flicker', () => {
    expect(dropIndexFor(mids, 50)).toBe(0)
    expect(dropIndexFor(mids, 51)).toBe(1)
  })

  it('returns 0 for an empty document', () => {
    expect(dropIndexFor([], 100)).toBe(0)
  })
})

/**
 * The gap index the pointer is over counts gaps in the list AS DISPLAYED,
 * which still contains the dragged tile. moveTo indexes the list with that
 * tile removed. These two cases are where the difference shows.
 */
describe('drop index conversion', () => {
  const order = ['a', 'b', 'c', 'd']

  /** What useDragReorder does on pointerup. */
  const drop = (id: string, gap: number): string[] => {
    const from = order.indexOf(id)
    return moveTo(order, id, from >= 0 && gap > from ? gap - 1 : gap)
  }

  it('drops between c and d when dragged down to that gap', () => {
    // Gap 3 is "between c and d" while a is still occupying slot 0.
    expect(drop('a', 3)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('drops at the very end', () => {
    expect(drop('a', 4)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('needs no adjustment dragging upward', () => {
    expect(drop('c', 0)).toEqual(['c', 'a', 'b', 'd'])
    expect(drop('d', 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('is a no-op dropping into its own gap', () => {
    expect(drop('b', 1)).toBe(order)
  })
})
