import { pageViewSize, type PageGeometry } from '@margin/transform'

export type FitMode = 'width' | 'page' | 'actual' | 'custom'

export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8] as const

const DEFAULT_PADDING = 32

// Amendment (Task 18 brief, ~line 165): the brief has this module import
// MIN_ZOOM/MAX_ZOOM from `@/stores/viewport`, while the store imports
// `computeFitZoom`/`nextZoomStep` from here — a genuine ES module cycle.
// Both constants live here instead, and `stores/viewport.ts` re-exports them
// for compatibility with existing imports (`import { MIN_ZOOM } from
// '@/stores/viewport'`). This file must never import from
// `@/stores/viewport` — that is exactly the cycle being broken.
export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 8

function clamp(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
}

export function computeFitZoom(args: {
  mode: Exclude<FitMode, 'custom'>
  containerWidth: number
  containerHeight: number
  geometry: PageGeometry
  padding?: number
}): number {
  const { mode, containerWidth, containerHeight, geometry, padding = DEFAULT_PADDING } = args
  if (mode === 'actual') return 1

  // Page size at zoom 1, which already accounts for rotation (a 90/270
  // rotated page swaps width/height — see pageViewSize).
  const { width: pw, height: ph } = pageViewSize(geometry, 1)
  if (pw <= 0 || ph <= 0) return 1

  // Math.max(1, ...) guards a zero-sized container during first layout
  // (before a ResizeObserver has ever fired) from producing 0/Infinity/NaN.
  const availW = Math.max(1, containerWidth - padding * 2)
  const availH = Math.max(1, containerHeight - padding * 2)

  const byWidth = availW / pw
  if (mode === 'width') return clamp(byWidth)
  return clamp(Math.min(byWidth, availH / ph))
}

export function nextZoomStep(current: number, direction: 1 | -1): number {
  if (direction === 1) {
    const up = ZOOM_STEPS.find((s) => s > current + 1e-6)
    return up ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!
  }
  const down = [...ZOOM_STEPS].reverse().find((s) => s < current - 1e-6)
  return down ?? ZOOM_STEPS[0]!
}
