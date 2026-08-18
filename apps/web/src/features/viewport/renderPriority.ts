import { cacheKey, type BitmapCache } from '@/lib/bitmapCache'
import type { PageId, PageState } from '@/stores/document'

/** Cheap whole-document pass; also feeds the thumbnail panel (spec §1.5). */
export const PLACEHOLDER_SCALE = 0.2

/**
 * Ceiling on render scale. A 4x zoom on a 3x-DPR phone would otherwise request
 * 12x, which is ~100MP for one Letter page — enough to crash the tab.
 */
const MAX_SCALE = 6

export function effectiveScale(zoom: number, dpr: number): number {
  return Math.min(zoom * dpr, MAX_SCALE)
}

export type RenderTask = {
  pageId: PageId
  sourceIndex: number
  scale: number
  tier: 'placeholder' | 'full'
}

export function planRenders(args: {
  pageOrder: PageId[]
  pages: Record<PageId, PageState>
  anchorIndex: number
  visibleRadius: number
  zoom: number
  dpr: number
  cache: BitmapCache
}): RenderTask[] {
  const { pageOrder, pages, anchorIndex, visibleRadius, zoom, dpr, cache } = args
  if (pageOrder.length === 0) return []

  const full: RenderTask[] = []
  const scale = effectiveScale(zoom, dpr)

  // Walk outward from the anchor: 0, -1, +1, -2, +2 … so a jump to page 200
  // renders page 200 first rather than grinding through everything before it.
  for (let d = 0; d <= visibleRadius; d++) {
    for (const i of d === 0 ? [anchorIndex] : [anchorIndex - d, anchorIndex + d]) {
      if (i < 0 || i >= pageOrder.length) continue
      const pageId = pageOrder[i]
      const page = pageId ? pages[pageId] : undefined
      if (!pageId || !page) continue
      if (cache.has(cacheKey(pageId, scale))) continue
      full.push({ pageId, sourceIndex: page.sourceIndex, scale, tier: 'full' })
    }
  }

  const placeholders: RenderTask[] = []
  for (const pageId of pageOrder) {
    const page = pages[pageId]
    if (!page) continue
    if (cache.has(cacheKey(pageId, PLACEHOLDER_SCALE))) continue
    placeholders.push({
      pageId, sourceIndex: page.sourceIndex, scale: PLACEHOLDER_SCALE, tier: 'placeholder',
    })
  }

  // Full renders always precede placeholders: what the user is looking at wins.
  return [...full, ...placeholders]
}
