import { describe, it, expect } from 'vitest'
import {
  bitmapBudgetMegapixels,
  DEFAULT_MEGAPIXELS,
  MIN_MEGAPIXELS,
  MAX_MEGAPIXELS,
} from '@/lib/memoryBudget'

describe('bitmapBudgetMegapixels', () => {
  // Safari and Firefox do not expose deviceMemory at all, so this is the
  // path most of the web takes -- it has to be the good one.
  it('falls back to the previously shipped constant when the device will not say', () => {
    expect(bitmapBudgetMegapixels({})).toBe(DEFAULT_MEGAPIXELS)
    expect(bitmapBudgetMegapixels({ deviceMemory: undefined })).toBe(DEFAULT_MEGAPIXELS)
  })

  // Nothing regresses on the hardware the previous constant was chosen for.
  it('lands exactly on the old constant at 4 GB', () => {
    expect(bitmapBudgetMegapixels({ deviceMemory: 4 })).toBe(DEFAULT_MEGAPIXELS)
  })

  it('gives a low-memory device less', () => {
    expect(bitmapBudgetMegapixels({ deviceMemory: 2 })).toBeLessThan(DEFAULT_MEGAPIXELS)
    expect(bitmapBudgetMegapixels({ deviceMemory: 1 })).toBeLessThan(
      bitmapBudgetMegapixels({ deviceMemory: 2 }),
    )
  })

  it('gives a large machine more', () => {
    expect(bitmapBudgetMegapixels({ deviceMemory: 8 })).toBeGreaterThan(DEFAULT_MEGAPIXELS)
  })

  // Below the floor the cache evicts bitmaps it is about to need again --
  // on the device least able to re-render them.
  it('never drops below a usable floor', () => {
    expect(bitmapBudgetMegapixels({ deviceMemory: 0.25 })).toBe(MIN_MEGAPIXELS)
    expect(bitmapBudgetMegapixels({ deviceMemory: 0.5 })).toBe(MIN_MEGAPIXELS)
  })

  it('never exceeds the ceiling', () => {
    expect(bitmapBudgetMegapixels({ deviceMemory: 64 })).toBe(MAX_MEGAPIXELS)
    expect(bitmapBudgetMegapixels({ deviceMemory: 1024 })).toBe(MAX_MEGAPIXELS)
  })

  it('ignores nonsense rather than trusting it', () => {
    expect(bitmapBudgetMegapixels({ deviceMemory: 0 })).toBe(DEFAULT_MEGAPIXELS)
    expect(bitmapBudgetMegapixels({ deviceMemory: -4 })).toBe(DEFAULT_MEGAPIXELS)
    expect(bitmapBudgetMegapixels({ deviceMemory: Number.NaN })).toBe(DEFAULT_MEGAPIXELS)
    expect(bitmapBudgetMegapixels({ deviceMemory: Number.POSITIVE_INFINITY })).toBe(DEFAULT_MEGAPIXELS)
  })

  it('is monotonic in device memory', () => {
    const budgets = [0.5, 1, 2, 4, 8, 16].map((gb) => bitmapBudgetMegapixels({ deviceMemory: gb }))
    for (let i = 1; i < budgets.length; i++) {
      expect(budgets[i]!).toBeGreaterThanOrEqual(budgets[i - 1]!)
    }
  })
})
