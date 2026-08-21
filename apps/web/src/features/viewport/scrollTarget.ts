/**
 * Breathing room above a point scrolled to, in CSS pixels. Landing with the
 * object flush against the viewport's top edge reads as clipped and hides
 * whatever it sits under, which is usually the thing that identifies it.
 */
export const SCROLL_MARGIN = 48

/**
 * Where the scroller should sit to show a point inside a page.
 *
 * `pageStart` is the page's own offset in the virtual list; `offset` is how
 * far down the page the point is, in view pixels. Both are already in the
 * scroller's units, so this is the whole of the maths -- the clamp exists
 * because the margin would otherwise ask for a negative scroll near the top
 * of the document.
 */
export function scrollTarget(pageStart: number, offset: number): number {
  return Math.max(0, pageStart + offset - SCROLL_MARGIN)
}
