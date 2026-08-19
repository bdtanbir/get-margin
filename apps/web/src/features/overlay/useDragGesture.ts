export type DragDelta = { dx: number; dy: number }

export type DragOptions = {
  onMove: (delta: DragDelta) => void
  onEnd: () => void
}

/**
 * A pointer drag reported as deltas in CSS pixels.
 *
 * Listeners go on `window`, not the element: a fast drag outruns the
 * element under the cursor, and a pointerup delivered outside it would
 * otherwise leave the gesture running forever. Pointer capture is requested
 * as well so the browser keeps routing events to the origin element where
 * it is supported.
 *
 * Deltas are CSS pixels; the CALLER converts to PDF space via
 * @margin/transform. This module performs no coordinate maths.
 */
export function useDragGesture(opts: DragOptions) {
  function onPointerDown(e: PointerEvent): void {
    const target = e.currentTarget as Element | null
    const startX = e.clientX
    const startY = e.clientY
    try {
      target?.setPointerCapture?.(e.pointerId)
    } catch {
      // Pointer capture is best-effort; window listeners are the guarantee.
    }

    const move = (ev: Event): void => {
      const p = ev as PointerEvent
      opts.onMove({ dx: p.clientX - startX, dy: p.clientY - startY })
    }

    const end = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      try {
        target?.releasePointerCapture?.(e.pointerId)
      } catch {
        // Already released, or never captured.
      }
      opts.onEnd()
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  return { onPointerDown }
}
