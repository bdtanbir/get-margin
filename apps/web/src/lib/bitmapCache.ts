import type { RenderResult } from '@/workers/pdfService'
import type { PageId } from '@/stores/document'
import { bitmapBudgetMegapixels } from '@/lib/memoryBudget'

export type CacheKey = string

/** Scale is rounded to 3 decimals so float drift can't fragment the cache. */
export function cacheKey(pageId: PageId, scale: number): CacheKey {
  return `${pageId}@${Math.round(scale * 1000) / 1000}`
}

/**
 * Amendment A1 (Task 16): the brief specified 200MP; at 4 bytes/pixel that
 * is 800MB of page bitmaps, untenable in a browser tab and impossible on
 * the phone this project commits to supporting. The arithmetic behind 50:
 * a Letter page at dpr 2 / zoom 1 is ~1.94MP; the visible page plus its
 * immediate neighbours (±1) is ~5.8MP (23MB); at zoom 2 that becomes
 * ~23MP (93MB); all 300 thumbnails at 0.2 scale add ~5.8MP (23MB) more.
 * That covers a demanding desktop session in ~30MP. 50MP (~200MB) leaves
 * headroom above that without inviting an out-of-memory crash.
 *
 * Phase 4 Task 61 re-measured it as that comment asked: a 300-page document
 * scrolled fifty pages sits at 215MB of heap, i.e. right ON this bound. The
 * default is now resolved per device (lib/memoryBudget.ts) and still comes
 * out at exactly 50 wherever the device does not report its memory, which
 * is Safari, Firefox, and anything else without navigator.deviceMemory.
 */

/**
 * LRU cache of rendered page bitmaps, capped by total megapixels (spec §1.5).
 *
 * A JS Map preserves insertion order, so re-inserting on read is enough to
 * maintain LRU order without a second data structure.
 */
export class BitmapCache {
  #map = new Map<CacheKey, RenderResult>()
  #megapixels = 0
  readonly #max: number

  constructor(maxMegapixels = bitmapBudgetMegapixels()) {
    this.#max = maxMegapixels
  }

  get megapixels(): number { return this.#megapixels }
  get size(): number { return this.#map.size }

  #mp(v: RenderResult): number { return (v.width * v.height) / 1_000_000 }

  get(key: CacheKey): RenderResult | undefined {
    const hit = this.#map.get(key)
    if (!hit) return undefined
    // Re-insert to move to the most-recent end.
    this.#map.delete(key)
    this.#map.set(key, hit)
    return hit
  }

  has(key: CacheKey): boolean { return this.#map.has(key) }

  set(key: CacheKey, value: RenderResult): void {
    this.delete(key) // avoid double-counting an overwrite
    this.#map.set(key, value)
    this.#megapixels += this.#mp(value)
    this.#evict(key)
  }

  /** Evict oldest entries until within budget, never the entry just inserted. */
  #evict(protectKey: CacheKey): void {
    for (const key of this.#map.keys()) {
      if (this.#megapixels <= this.#max) break
      if (key === protectKey) continue
      this.delete(key)
    }
  }

  delete(key: CacheKey): void {
    const existing = this.#map.get(key)
    if (!existing) return
    this.#megapixels -= this.#mp(existing)
    this.#map.delete(key)
    if (this.#map.size === 0) this.#megapixels = 0 // guard float accumulation
  }

  /** Drop every cached scale for one page. Used when a page's source changes. */
  invalidatePage(pageId: PageId): void {
    const prefix = `${pageId}@`
    for (const key of [...this.#map.keys()]) {
      if (key.startsWith(prefix)) this.delete(key)
    }
  }

  clear(): void {
    this.#map.clear()
    this.#megapixels = 0
  }
}
