import { describe, it, expect } from 'vitest'
import { scrollTarget, SCROLL_MARGIN } from '@/features/viewport/scrollTarget'

describe('scrollTarget', () => {
  // Landing with the object flush against the top edge reads as clipped,
  // and gives no sense of where on the page the thing actually is.
  it('leaves a margin above the point asked for', () => {
    expect(scrollTarget(1000, 400)).toBe(1000 + 400 - SCROLL_MARGIN)
  })

  // Near the very top of the document the margin would ask the scroller to
  // go above the start, which browsers clamp silently -- but a negative
  // offset is not something to hand out and hope.
  it('never asks the scroller to go above the document start', () => {
    expect(scrollTarget(0, 10)).toBe(0)
  })

  it('is the page top itself when the point is the page top', () => {
    expect(scrollTarget(1000, 0)).toBe(1000 - SCROLL_MARGIN)
  })
})
