import { describe, it, expect } from 'vitest'
import { planRenders, effectiveScale, PLACEHOLDER_SCALE } from '../../src/features/viewport/renderPriority.js'
import { BitmapCache, cacheKey } from '../../src/lib/bitmapCache.js'

const GEOM = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }

function doc(n: number) {
  const pageOrder = Array.from({ length: n }, (_, i) => `p${i}`)
  const pages = Object.fromEntries(
    pageOrder.map((id, i) => [id, { id, sourceId: 'src-0', sourceIndex: i, geometry: GEOM }]),
  )
  return { pageOrder, pages }
}

const base = { visibleRadius: 1, zoom: 1, dpr: 2 }

describe('effectiveScale', () => {
  it('multiplies zoom by device pixel ratio', () => {
    expect(effectiveScale(1, 2)).toBe(2)
    expect(effectiveScale(1.5, 2)).toBe(3)
  })

  it('clamps to a ceiling so a 4x zoom on a retina phone cannot request 8x', () => {
    expect(effectiveScale(8, 3)).toBeLessThanOrEqual(6)
  })
})

describe('planRenders', () => {
  it('puts the anchor page first', () => {
    const cache = new BitmapCache(500)
    const tasks = planRenders({ ...doc(50), ...base, anchorIndex: 20, cache })
    expect(tasks[0]?.pageId).toBe('p20')
    expect(tasks[0]?.tier).toBe('full')
  })

  it('orders full renders by distance from the anchor', () => {
    const cache = new BitmapCache(500)
    const tasks = planRenders({ ...doc(50), ...base, anchorIndex: 20, visibleRadius: 2, zoom: 1, dpr: 2, cache })
    const full = tasks.filter((t) => t.tier === 'full').map((t) => t.pageId)
    expect(full.slice(0, 5)).toEqual(['p20', 'p19', 'p21', 'p18', 'p22'])
  })

  it('emits full renders only within the visible radius', () => {
    const cache = new BitmapCache(500)
    const tasks = planRenders({ ...doc(50), ...base, anchorIndex: 20, cache })
    const full = tasks.filter((t) => t.tier === 'full')
    expect(full).toHaveLength(3) // 19, 20, 21
  })

  it('queues placeholder renders for every page, after the full ones', () => {
    const cache = new BitmapCache(500)
    const tasks = planRenders({ ...doc(10), ...base, anchorIndex: 0, cache })
    const firstPlaceholder = tasks.findIndex((t) => t.tier === 'placeholder')
    const lastFull = tasks.map((t) => t.tier).lastIndexOf('full')
    expect(firstPlaceholder).toBeGreaterThan(lastFull)
    expect(tasks.filter((t) => t.tier === 'placeholder')).toHaveLength(10)
  })

  it('uses PLACEHOLDER_SCALE for placeholder tasks regardless of zoom', () => {
    const cache = new BitmapCache(500)
    const tasks = planRenders({ ...doc(5), ...base, anchorIndex: 0, zoom: 4, dpr: 2, cache })
    for (const t of tasks.filter((x) => x.tier === 'placeholder')) {
      expect(t.scale).toBe(PLACEHOLDER_SCALE)
    }
  })

  it('skips anything already cached', () => {
    const cache = new BitmapCache(500)
    const d = doc(10)
    // page/scale are unused by this test but RenderResult requires them
    // (Task 16) — filled with harmless constants, matching the pattern
    // established in bitmapCache.test.ts and PageCanvas.test.ts.
    cache.set(cacheKey('p0', effectiveScale(1, 2)), { width: 10, height: 10, rgba: new Uint8Array(400), page: 0, scale: effectiveScale(1, 2) })
    cache.set(cacheKey('p0', PLACEHOLDER_SCALE), { width: 4, height: 4, rgba: new Uint8Array(64), page: 0, scale: PLACEHOLDER_SCALE })
    const tasks = planRenders({ ...d, ...base, anchorIndex: 0, cache })
    expect(tasks.some((t) => t.pageId === 'p0')).toBe(false)
  })

  it('re-queues a page at a new zoom because the cache key changed', () => {
    const cache = new BitmapCache(500)
    const d = doc(3)
    cache.set(cacheKey('p0', effectiveScale(1, 2)), { width: 10, height: 10, rgba: new Uint8Array(400), page: 0, scale: effectiveScale(1, 2) })
    const tasks = planRenders({ ...d, ...base, anchorIndex: 0, zoom: 2, dpr: 2, cache })
    expect(tasks.some((t) => t.pageId === 'p0' && t.tier === 'full')).toBe(true)
  })

  it('clamps the radius at document boundaries', () => {
    const cache = new BitmapCache(500)
    const tasks = planRenders({ ...doc(3), ...base, anchorIndex: 0, visibleRadius: 5, zoom: 1, dpr: 2, cache })
    const full = tasks.filter((t) => t.tier === 'full').map((t) => t.pageId)
    expect(full).toEqual(['p0', 'p1', 'p2'])
  })

  it('returns nothing for an empty document', () => {
    expect(planRenders({ pageOrder: [], pages: {}, ...base, anchorIndex: 0, cache: new BitmapCache(1) })).toEqual([])
  })
})
