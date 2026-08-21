import type { PageQuadIndex, Quad } from '@margin/pdf-core'
import { useSelectionStore, type CharRef } from '@/stores/selection'
import { useDragGesture } from './useDragGesture'

/**
 * Distance, in page-space units, beyond a line's box that still counts as
 * being on that line. Without a little slack, a drag that strays into the
 * leading between two lines selects nothing and the selection visibly
 * stutters.
 */
const LINE_SLACK = 2

const yMin = (q: Quad): number => Math.min(q[1]!, q[3]!, q[5]!, q[7]!)
const yMax = (q: Quad): number => Math.max(q[1]!, q[3]!, q[5]!, q[7]!)
const xMin = (q: Quad): number => Math.min(q[0]!, q[2]!, q[4]!, q[6]!)
const xMax = (q: Quad): number => Math.max(q[0]!, q[2]!, q[4]!, q[6]!)

/**
 * The character nearest a point in PAGE SPACE.
 *
 * Nearest, not strictly-containing: a pointer in the gap between two glyphs
 * or just past the end of a line must still resolve to a character, or the
 * selection drops out wherever the cursor is between letters.
 */
export function charAt(index: PageQuadIndex, x: number, y: number): CharRef | undefined {
  let best: CharRef | undefined
  let bestDistance = Infinity

  index.lines.forEach((line, l) => {
    const [, y0, , y1] = line.bbox
    const top = Math.min(y0, y1) - LINE_SLACK
    const bottom = Math.max(y0, y1) + LINE_SLACK
    // Vertical distance to the line's band, zero when inside it.
    const dy = y < top ? top - y : y > bottom ? y - bottom : 0

    line.chars.forEach((c, i) => {
      const left = xMin(c.quad)
      const right = xMax(c.quad)
      const dx = x < left ? left - x : x > right ? x - right : 0
      // Vertical distance dominates: a point below a short line belongs to
      // the line beneath it, not to the far end of the one above.
      const distance = dy * 1000 + dx
      if (distance < bestDistance) {
        bestDistance = distance
        best = { line: l, char: i }
      }
    })
  })

  return best
}

/** Exposed for tests and for the layer's own hit-testing geometry. */
export const quadBounds = { xMin, xMax, yMin, yMax }

export type SelectionSurface = {
  /** Maps a client point into the element's own user-space coordinates. */
  toPageSpace: (clientX: number, clientY: number) => { x: number; y: number } | undefined
}

/**
 * Drag-to-select over a page's text.
 *
 * Coordinate conversion goes through the SVG element's own
 * getScreenCTM().inverse(), so the browser performs the maths (spec 1.4) --
 * the overlay's root <g> already carries the page transform, and asking the
 * DOM where a client point lands inside it is exact for every zoom,
 * rotation, and scroll offset without this module reimplementing any of it.
 */
export function useTextSelection(
  page: () => string,
  index: () => PageQuadIndex | undefined,
  surface: SelectionSurface,
) {
  const selection = useSelectionStore()

  function onPointerDown(e: PointerEvent): void {
    const idx = index()
    const start = surface.toPageSpace(e.clientX, e.clientY)
    if (!idx || !start) return
    const from = charAt(idx, start.x, start.y)
    if (!from) return
    // The page under the pointer owns the selection, together with the
    // index its refs address -- never whichever page's index landed last.
    selection.begin(page(), idx, from)

    const { onPointerDown: begin } = useDragGesture({
      onMove: ({ dx, dy }) => {
        const p = surface.toPageSpace(e.clientX + dx, e.clientY + dy)
        if (!p) return
        const to = charAt(idx, p.x, p.y)
        if (to) selection.extend(to)
      },
      onEnd: () => {},
    })
    begin(e)
  }

  return { onPointerDown }
}
