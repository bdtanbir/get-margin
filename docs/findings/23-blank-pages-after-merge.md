# Blank pages after adding a second document

Reported from use, immediately after the page-navigation fix: "I uploaded this pdf but there is
nothing I can see." The exported file was correct — so the document data was fine and only the
viewer was wrong.

## What happened

Opening one document and then merging a second left the viewer entirely blank. Measured by reading
pixels out of the page canvases:

```
after opening        page 1: 2.0% ink        (painted)
after adding a file  page 1: no canvas at all (-1)
```

Not just the new page — the page that had been rendering fine went blank too.

## Root cause: a render-plan input that never marked the plan dirty

`planRenders` takes `doc.pageOrder` and `doc.pages` among its inputs. `pump()` is a
`while (dirty)` loop, so with `dirty` false it does nothing at all.

The viewport store's own invariant, written three phases earlier, says:

> every input to the render plan produced by `planRenders` — not just `effectiveScale`… but also
> `anchorIndex`, which decides which pages the plan even considers — must mark the plan dirty when
> it changes

**The page set is such an input, and nothing marked the plan dirty when it changed.** Adding,
deleting or reordering pages left `dirty` false, so no render was ever planned for the new pages.

### Why it only appeared now

The scroller used to compute the current page from the midpoint of the virtualiser's item *array*
(`docs/findings/22-page-navigation.md`). That midpoint moved whenever the page count changed, so
`setAnchor` received a different value and set `dirty` as a **side effect**. Merging worked by
accident, on the back of a bug.

Fixing the anchor calculation made `setAnchor` correctly a no-op when the current page had not
changed — which removed the accidental `dirty` and exposed the real defect underneath.

**Fix:** the store watches the page order and marks the plan dirty when it changes. Keyed on the
joined ids rather than array identity, because the getter behind `pageOrder` recomputes on unrelated
edit-store changes and re-planning on every brush stroke would be waste.

## A second defect, found while verifying the first

The viewer labelled pages from `page.sourceIndex` — the page's index inside the file it came from —
rather than its display position. In a merged document every source's first page announced itself as
"Page 1": the same page number twice, disagreeing with the thumbnail beside it, and wrong for any
document whose pages have been reordered.

`Thumbnail.vue` carries an explicit comment about this exact trap and gets it right. `PageCanvas`
did not. It now takes the display index.

## Why no test caught either

The navigation suite added hours earlier asserted **where** pages were, never that anything had been
**drawn** into them — so it passed while every page rendered blank.

The first version of the replacement tests was no better, and this is the part worth remembering:
they opened a 12-page document and appended a page. The appended page landed off-screen, the pages
already rendered stayed painted, and **the suite went green with both bugs fully present**. Verified
by reverting both fixes and watching them pass.

The reported case is a *short* document, where the added page is immediately in view. The tests now
use one-page documents for exactly that reason, and both fail when their fix is removed.

## Verified

With both fixes reverted: the merge test reports `-1` (no canvas was ever created) and the label test
reports `["Page 1", "Page 1"]`. With them in place, both pages paint and the labels read
`["Page 1", "Page 2"]`.
