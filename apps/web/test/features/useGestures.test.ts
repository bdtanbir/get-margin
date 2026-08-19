import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useGestures } from '@/features/viewport/useGestures'

function pointer(id: number, x: number, y: number, width = 1): PointerEvent {
  return {
    pointerId: id, clientX: x, clientY: y, pointerType: 'touch', width, height: width,
  } as PointerEvent
}

describe('useGestures', () => {
  let onPinch: ReturnType<typeof vi.fn>
  let onPan: ReturnType<typeof vi.fn>
  let g: ReturnType<typeof useGestures>

  beforeEach(() => {
    onPinch = vi.fn()
    onPan = vi.fn()
    g = useGestures({ onPinch, onPan })
  })

  it('pans with one finger', () => {
    g.onPointerDown(pointer(1, 100, 100))
    g.onPointerMove(pointer(1, 130, 90))
    expect(onPan).toHaveBeenCalledWith({ dx: 30, dy: -10 })
  })

  it('reports pan deltas relative to the last position, not the start', () => {
    g.onPointerDown(pointer(1, 100, 100))
    g.onPointerMove(pointer(1, 110, 100))
    g.onPointerMove(pointer(1, 130, 100))
    expect(onPan).toHaveBeenLastCalledWith({ dx: 20, dy: 0 })
  })

  it('pinches with two fingers, reporting relative scale', () => {
    g.onPointerDown(pointer(1, 0, 0))
    g.onPointerDown(pointer(2, 100, 0))
    g.onPointerMove(pointer(2, 200, 0))
    expect(onPinch).toHaveBeenCalledTimes(1)
    expect(onPinch.mock.calls[0]![0]).toBeCloseTo(2, 5)
  })

  it('reports the midpoint so the caller can zoom about it', () => {
    g.onPointerDown(pointer(1, 0, 0))
    g.onPointerDown(pointer(2, 100, 0))
    g.onPointerMove(pointer(2, 200, 0))
    expect(onPinch.mock.calls[0]![1]).toEqual({ x: 100, y: 0 })
  })

  // Without a baseline taken when the second finger lands, the first pinch
  // event would report an enormous scale and the page would leap.
  it('does not jump when a second finger arrives mid-pan', () => {
    g.onPointerDown(pointer(1, 0, 0))
    g.onPointerMove(pointer(1, 50, 0))
    onPan.mockClear()
    g.onPointerDown(pointer(2, 150, 0))
    g.onPointerMove(pointer(2, 151, 0))
    // A 1px change against a 100px baseline is under the threshold.
    expect(onPinch).not.toHaveBeenCalled()
    expect(onPan).not.toHaveBeenCalled()
  })

  it('ignores a jitter smaller than the pinch threshold', () => {
    g.onPointerDown(pointer(1, 0, 0))
    g.onPointerDown(pointer(2, 100, 0))
    g.onPointerMove(pointer(2, 100.5, 0))
    expect(onPinch).not.toHaveBeenCalled()
  })

  // A palm resting on the screen while a finger draws must not become a
  // second contact and zoom the document.
  it('ignores a palm-sized contact', () => {
    g.onPointerDown(pointer(1, 0, 0))
    g.onPointerDown(pointer(2, 100, 0, 80))
    g.onPointerMove(pointer(2, 300, 0, 80))
    expect(onPinch).not.toHaveBeenCalled()
    expect(g.contacts.value).toHaveLength(1)
  })

  it('still pans while a palm is down', () => {
    g.onPointerDown(pointer(1, 0, 0))
    g.onPointerDown(pointer(2, 100, 0, 80))
    g.onPointerMove(pointer(1, 20, 0))
    expect(onPan).toHaveBeenCalledWith({ dx: 20, dy: 0 })
  })

  // A whole hand on the screen is not a gesture.
  it('ignores a third contact', () => {
    g.onPointerDown(pointer(1, 0, 0))
    g.onPointerDown(pointer(2, 100, 0))
    g.onPointerDown(pointer(3, 200, 0))
    expect(g.contacts.value).toHaveLength(2)
  })

  it('does not treat a wide MOUSE pointer as a palm', () => {
    const mouse = { ...pointer(1, 0, 0, 200), pointerType: 'mouse' } as PointerEvent
    g.onPointerDown(mouse)
    expect(g.contacts.value).toHaveLength(1)
  })

  // Otherwise the page jumps by the gap between the two fingers.
  it('resumes panning from the remaining finger after one lifts', () => {
    g.onPointerDown(pointer(1, 0, 0))
    g.onPointerDown(pointer(2, 100, 0))
    g.onPointerUp(pointer(2, 100, 0))
    onPan.mockClear()
    g.onPointerMove(pointer(1, 10, 0))
    expect(onPan).toHaveBeenCalledWith({ dx: 10, dy: 0 })
  })

  it('forgets everything on reset', () => {
    g.onPointerDown(pointer(1, 0, 0))
    g.onPointerDown(pointer(2, 100, 0))
    g.reset()
    expect(g.contacts.value).toHaveLength(0)
    g.onPointerMove(pointer(1, 50, 0))
    expect(onPan).not.toHaveBeenCalled()
  })

  it('ignores a move from a pointer it never saw down', () => {
    g.onPointerMove(pointer(9, 50, 50))
    expect(onPan).not.toHaveBeenCalled()
  })
})
