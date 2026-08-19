import { describe, it, expect, vi } from 'vitest'
import { useDragGesture } from '@/features/overlay/useDragGesture'

function pointer(type: string, x: number, y: number): PointerEvent {
  const e = new Event(type, { bubbles: true }) as PointerEvent
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1 })
  return e
}

/**
 * `currentTarget` is a getter-only accessor on Event.prototype, so
 * `Object.assign` throws ("only a getter") rather than shadowing it. The
 * browser sets it during dispatch; here the composable is called directly,
 * so it has to be defined as an own property instead.
 */
function withTarget(e: PointerEvent, el: Element): PointerEvent {
  Object.defineProperty(e, 'currentTarget', { value: el, configurable: true })
  return e
}

function handleEl(): HTMLDivElement {
  const el = document.createElement('div')
  el.setPointerCapture = vi.fn()
  el.releasePointerCapture = vi.fn()
  return el
}

describe('useDragGesture', () => {
  it('reports deltas relative to the pointer-down position', () => {
    const moves: Array<{ dx: number; dy: number }> = []
    const { onPointerDown } = useDragGesture({
      onMove: (d) => moves.push(d),
      onEnd: () => {},
    })
    const el = handleEl()
    onPointerDown(withTarget(pointer('pointerdown', 100, 100), el))
    window.dispatchEvent(pointer('pointermove', 130, 90))
    expect(moves).toEqual([{ dx: 30, dy: -10 }])
  })

  it('calls onEnd exactly once and stops listening after pointerup', () => {
    const onEnd = vi.fn()
    const onMove = vi.fn()
    const { onPointerDown } = useDragGesture({ onMove, onEnd })
    const el = handleEl()
    onPointerDown(withTarget(pointer('pointerdown', 0, 0), el))
    window.dispatchEvent(pointer('pointerup', 10, 10))
    window.dispatchEvent(pointer('pointermove', 50, 50))
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('ends the gesture on pointercancel too', () => {
    const onEnd = vi.fn()
    const { onPointerDown } = useDragGesture({ onMove: () => {}, onEnd })
    const el = handleEl()
    onPointerDown(withTarget(pointer('pointerdown', 0, 0), el))
    window.dispatchEvent(pointer('pointercancel', 0, 0))
    expect(onEnd).toHaveBeenCalledTimes(1)
  })
})
