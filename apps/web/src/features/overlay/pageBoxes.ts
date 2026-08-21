/**
 * Where each mounted page sits on screen.
 *
 * An object belongs to exactly one page, so dragging one to another page is
 * a change of OWNER, not just of coordinates -- and the only thing that can
 * say which page the pointer is over is the pages' own boxes on screen.
 * The scroller lays pages out itself (virtualised, centred, zoomed), so
 * asking the DOM is both cheaper and more honest than re-deriving that
 * layout here.
 */
export type PageBox = {
  id: string
  /** Client coordinates, as getBoundingClientRect reports them. */
  left: number
  top: number
  width: number
  height: number
}

/**
 * Every page currently laid out, in document order.
 *
 * A page with no measured box -- not laid out yet, hidden, or jsdom -- is
 * not a drop target. Keeping a 0x0 rect in the list would make it match
 * nothing useful and, worse, sit in front of a real page for a point at the
 * origin.
 */
export function pageBoxes(root: ParentNode = document): PageBox[] {
  return [...root.querySelectorAll<HTMLElement>('[data-page-id]')].flatMap((el) => {
    const id = el.dataset.pageId
    const r = el.getBoundingClientRect()
    if (!id || r.width === 0 || r.height === 0) return []
    return [{ id, left: r.left, top: r.top, width: r.width, height: r.height }]
  })
}

/**
 * The page under a client point, or undefined for the gutter between two
 * sheets. Undefined is a real answer, not a failure: a drop that lands
 * between pages must leave the object on the page it came from rather than
 * guessing at the nearest one.
 */
export function pageAtPoint(x: number, y: number, boxes: PageBox[]): PageBox | undefined {
  return boxes.find(
    (b) => x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height,
  )
}
