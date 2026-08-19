/**
 * How much page bitmap this device can afford to cache, in megapixels.
 *
 * Measured context (docs/findings/10-large-document-performance.md): a
 * 300-page document scrolled fifty pages sits at 215 MB of JS heap, right
 * against the previous fixed 50-megapixel cap (≈200 MB at 4 bytes/pixel).
 * On a desktop that is unremarkable. On a mid-range phone sharing 3–4 GB
 * with the whole system it is the number that ends the session.
 */

/** Today's constant, and the answer whenever the device will not say. */
export const DEFAULT_MEGAPIXELS = 50

/**
 * Below this the cache cannot hold the visible page, its two neighbours,
 * and the thumbnail strip at once (~12 MP by the arithmetic in
 * bitmapCache.ts), so it would thrash: evicting bitmaps it is about to
 * need again, on the device least able to re-render them.
 */
export const MIN_MEGAPIXELS = 12

/** ~400 MB. A 64 GB workstation should not cache without bound either. */
export const MAX_MEGAPIXELS = 100

/** 4 GB lands exactly on the previous constant, so nothing regresses. */
const MEGAPIXELS_PER_GB = 12.5

type MemoryHints = {
  /** `navigator.deviceMemory`, in GB. Chromium and Android only. */
  deviceMemory?: number | undefined
}

/**
 * Resolve the budget.
 *
 * DEGRADES TO THE FIXED CONSTANT, never depends on the hint: Safari and
 * Firefox do not expose `deviceMemory` at all, so a budget that required
 * it would leave most of the web on whatever fallback was written
 * carelessly. Here the fallback IS the previously shipped value.
 */
export function bitmapBudgetMegapixels(hints: MemoryHints = readHints()): number {
  const gb = hints.deviceMemory
  if (typeof gb !== 'number' || !Number.isFinite(gb) || gb <= 0) return DEFAULT_MEGAPIXELS
  const scaled = gb * MEGAPIXELS_PER_GB
  return Math.max(MIN_MEGAPIXELS, Math.min(MAX_MEGAPIXELS, Math.round(scaled)))
}

export function readHints(): MemoryHints {
  if (typeof navigator === 'undefined') return {}
  const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  return { deviceMemory: value }
}
