import { ref } from 'vue'

/**
 * A contact wider than this is a palm or a knuckle, not a fingertip.
 * `PointerEvent.width`/`height` are in CSS pixels and default to 1 for a
 * mouse, so this only ever excludes genuinely broad touches.
 */
const PALM_RADIUS_PX = 45

/** Below this, a two-finger movement is a pan, not a deliberate pinch. */
const PINCH_THRESHOLD = 0.02

export type GestureHandlers = {
  /** Relative scale since the last event, and the midpoint in client coords. */
  onPinch: (scale: number, centre: { x: number; y: number }) => void
  onPan: (delta: { dx: number; dy: number }) => void
}

type Contact = { id: number; x: number; y: number }

const distance = (a: Contact, b: Contact): number => Math.hypot(b.x - a.x, b.y - a.y)
const midpoint = (a: Contact, b: Contact) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/**
 * Pinch-to-zoom and one-finger pan for the page surface.
 *
 * Three behaviours that separate a usable touch surface from a frustrating
 * one, and that the viewport had none of:
 *
 *  - a second finger arriving mid-pan switches to pinch WITHOUT a jump,
 *    because the baseline distance is taken at that moment rather than
 *    carried over from nothing;
 *  - a palm resting on the screen while a finger draws is ignored, rather
 *    than being treated as a second contact and zooming the document;
 *  - lifting one finger of a pinch resumes panning with the other rather
 *    than jumping by the gap between them.
 *
 * Scale is reported RELATIVE, so the caller multiplies its own zoom and
 * this module never needs to know what the current zoom is -- no
 * coordinate maths lives here.
 */
export function useGestures(handlers: GestureHandlers) {
  const contacts = ref<Contact[]>([])
  let lastDistance = 0
  let lastPoint: { x: number; y: number } | undefined

  function isPalm(e: PointerEvent): boolean {
    if (e.pointerType !== 'touch') return false
    return Math.max(e.width ?? 0, e.height ?? 0) > PALM_RADIUS_PX
  }

  function onPointerDown(e: PointerEvent): void {
    // A palm never becomes a contact, so it can neither pan nor start a
    // pinch -- the whole point of rejecting it.
    if (isPalm(e)) return
    // More than two contacts is a hand on the screen, not a gesture.
    if (contacts.value.length >= 2) return

    contacts.value = [...contacts.value, { id: e.pointerId, x: e.clientX, y: e.clientY }]
    if (contacts.value.length === 2) {
      const [a, b] = contacts.value as [Contact, Contact]
      // Baseline taken NOW, so the switch from pan to pinch does not jump.
      lastDistance = distance(a, b)
      lastPoint = undefined
    } else {
      lastPoint = { x: e.clientX, y: e.clientY }
    }
  }

  function onPointerMove(e: PointerEvent): void {
    const index = contacts.value.findIndex((c) => c.id === e.pointerId)
    if (index < 0) return

    const next = [...contacts.value]
    next[index] = { id: e.pointerId, x: e.clientX, y: e.clientY }
    contacts.value = next

    if (next.length === 2) {
      const [a, b] = next as [Contact, Contact]
      const current = distance(a, b)
      if (lastDistance > 0) {
        const scale = current / lastDistance
        if (Math.abs(scale - 1) > PINCH_THRESHOLD) {
          handlers.onPinch(scale, midpoint(a, b))
          lastDistance = current
        }
      } else {
        lastDistance = current
      }
      return
    }

    if (lastPoint) {
      handlers.onPan({ dx: e.clientX - lastPoint.x, dy: e.clientY - lastPoint.y })
      lastPoint = { x: e.clientX, y: e.clientY }
    }
  }

  function onPointerUp(e: PointerEvent): void {
    contacts.value = contacts.value.filter((c) => c.id !== e.pointerId)
    lastDistance = 0
    // Resume panning from wherever the remaining finger IS, not from where
    // the lifted one was -- otherwise the page jumps by the gap between them.
    const remaining = contacts.value[0]
    lastPoint = remaining ? { x: remaining.x, y: remaining.y } : undefined
  }

  function reset(): void {
    contacts.value = []
    lastDistance = 0
    lastPoint = undefined
  }

  return { onPointerDown, onPointerMove, onPointerUp, reset, contacts }
}
