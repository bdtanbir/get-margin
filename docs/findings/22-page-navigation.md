# Clicking a page in the sidebar did not go to that page

Reported from use: "I clicked on the first page but it does not took me to the first page."

## What was actually happening

Worse than reported, and not limited to the two-page document it was noticed on. Measured in a real
browser before touching anything:

| Document | Anchor after opening | Click page 1 → lands on | Click page 12 → lands on |
|---|---|---|---|
| 4 pages | page 3 | page 3 | — |
| 12 pages | page 3 | page 3 | page 11 |

**Opening a document scrolled it to page 3 on its own.** Clicking page 1 did nothing, because the
viewer was already on page 3 and believed that was correct.

## Root cause — two defects compounding

### 1. The current page was computed from the wrong thing

```js
const mid = list[Math.floor(list.length / 2)]
vp.setAnchor(mid.index)
```

`list` is the virtualiser's item array — the visible range **plus overscan** — not something centred
on the viewport. At the top of a document that array is `[0,1,2,3,4]`, so its midpoint is index 2.
The anchor was then fed back into `scrollToIndex`, so the viewer physically scrolled to the page its
own miscalculation had named. Hence page 3, on open, from a standing start.

For a two-page document the array is `[0,1]` and the midpoint is index 1 — which is why it always
looked like the last page was selected.

Fixed by finding the item whose extent actually contains the middle of the scrolled viewport.

### 2. One signal carried two different meanings

`anchorIndex` meant both *"the user scrolled here"* (written by the scroller) and *"take me here"*
(written by the thumbnail grid and the find panel). One watcher scrolled on any change, so every
scroll-driven update was read back as an instruction to scroll and the scroller fought itself.

The existing workaround was `align: 'auto'`, which only scrolls when the target is off-screen. That
stopped the loop — and silently swallowed real navigation to any page already partly on screen.
Clicking the next page down did nothing at all, which is the second half of what was reported.

Fixed by splitting the two: `setAnchor` records position and never scrolls; `goToPage` requests
navigation and always scrolls, with `align: 'start'` because "go to page 8" means put page 8 at the
top. A nonce on the request makes asking for the same page twice scroll twice.

## Why no test caught it

There was no test that clicked a thumbnail and then asserted what was **on screen**. The existing
coverage asserted `anchorIndex` changed — and `anchorIndex` was the thing that was wrong, so it
agreed with the bug. `e2e/navigation.spec.ts` now asserts the rendered result in a real browser, on
all four engines.

One assertion in that spec had to be written carefully: "the topmost visible page" is wrong at the
end of a document, because scrolling is clamped and the last page cannot be put at the top when
there is no screenful below it. It measures the page occupying most of the viewport instead, which
holds at both ends.

## Verified

Restoring only the old midpoint calculation turns the new spec red again (opening lands on page 2,
clicking page 12 lands on 11), so the test fails for the reason it was written for.
