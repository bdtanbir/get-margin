# The text tool read the wrong file on a merged document

Reported from use: clicking "Dear MD. HASANUZZAMAN" on page 2 opened an editor containing
"Team: Dev Team" — a line from page 1, from the *other* file.

## Root cause: one lookup that never learned about sources

Phase 3 added merging, and with it `#docFor(sourceId)` — the handle for whichever file a page came
from. `render()` uses it. `listFields()` uses it. **`quadIndex()` did not.**

```ts
quadIndex(page: number): PageQuadIndex {
  const doc = this.#doc          // the PRIMARY document, always
  ...
}
```

Two things then compounded:

1. **The overlay passed only `sourceIndex`** — the page's index *inside its own file*. The first
   page of every file is `sourceIndex` 0, so page two of a merge asked for "page 0".
2. **The cache was keyed by page number alone**, so two files' page 0 were the same entry. Even a
   corrected lookup would have been served the first file's answer.

Result: every page of a merged-in file got the primary document's text, line boxes, and content.
Measured before the fix — page 1 and page 2 reported an identical target count; after, 2 and 6,
matching the two files.

## What it affected

Not only the Edit Text tool. `quadIndex` is the character geometry behind **text selection** and
**find** as well, so all three read the wrong file on any page from a merged source. Committing an
edit would have covered text on the wrong page with the wrong replacement.

## Fix

`quadIndex(sourceId, page)`, resolved through `#docFor` like every other per-page reader, with the
cache keyed `sourceId:page`. `sourceId` is a required parameter rather than an optional one:
omitting it silently meant "the primary document", which is exactly the wrong default and produced
no error to notice.

## Still broken, and not fixed here

**`find` only ever searches the primary document.** It iterates `this.#doc.pageCount` and reports a
source page index, and `FindPanel` maps that back through `sourceIndex`. On a merged document, pages
from other files are never searched, and the mapping is ambiguous once two files both have a page 0.

That is a change to `find`'s contract — the worker would need the document's page list, and the
panel's index mapping would have to change with it. It is a separate defect with a separate design,
recorded here rather than bundled into this one.

## Why no test caught it

Every existing test of the text tools used a single-source document, where `sourceIndex` and the
document page index are the same number and the primary document is the only document. The bug was
invisible by construction. The new test merges two files with visibly different text, so reading the
wrong one is unmistakable rather than merely suspicious.
