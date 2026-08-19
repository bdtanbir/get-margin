# Findings: Phase 3 (page operations) pre-flight

Measured after merging Phase 2, before designing Phase 3. Every API the phase depends on was run
against real fixtures rather than read off the `.d.ts` and assumed.

Environment: mupdf 1.28.0, Node v20.16.0.

## The four primitives all work

| Operation | Call | Result |
|---|---|---|
| Rotate a page | `page.getObject().put('Rotate', 90)` | Persists; `getBounds()` swaps to 792×612 |
| Crop | `page.setPageBox('CropBox', rect)` | Persists — **but see the coordinate warning below** |
| Delete a page | `doc.deletePage(at)` | 12 pages → 11 |
| Extract / split / merge | `target.graftPage(-1, srcDoc, srcPage)` | Order preserved; 2 grafted pages = 1,237 bytes |

`graftPage(-1, ...)` appends. Grafting pages 2 then 0 of `multi-page.pdf` into a fresh
`new mupdf.PDFDocument()` produced a document reading "Page 3" then "Page 1" — so extraction,
reordering, and merging are all the same primitive.

## ⚠ `setPageBox` takes CONVENTION A, not raw PDF space

**This is the trap in the phase.** Called as:

```js
page.setPageBox('CropBox', [100, 100, 400, 500])
```

the raw `/CropBox` written to disk is **`[100, 292, 400, 692]`**, not `[100, 100, 400, 500]`.

On a 792pt-tall page, top-down `y = 100..500` is bottom-up `y = 792-500 .. 792-100` = `292..692`.
So `setPageBox` accepts **MuPDF page space** — top-down, CropBox-origin normalised, `/Rotate`
applied — exactly like `setRect`, `setQuadPoints`, and every other annotation setter
(`packages/pdf-core/src/write/coords.ts`, Convention A).

Consequence for Phase 3: the crop writer must pass its rect through the existing `toAnnotSpace()`,
**not** `toContentSpace()`. A raw bottom-up rect is accepted silently and produces a vertically
mirrored crop — which on a near-symmetric crop looks entirely plausible. This needs a pinning test
of the same kind as `test/write/pinning.test.ts`.

## Cropping does NOT move existing objects

`readBox` (`packages/pdf-core/src/geometry.ts:51`) reads the raw `/CropBox` off the page object
dict, **not** `getBounds()` — which normalises the origin to `(0,0)` and would lose it. Verified
end to end: after the crop above, `pageGeometry(0)` reports `cropBox: [100, 292, 400, 692]`.

That matters because `svgViewBox`/`svgRootTransform` already subtract the CropBox origin, and every
`EditObject.rect` is raw PDF user space that a crop does not change. So a crop re-frames the page
and objects keep their coordinates automatically — the deferred-bake architecture paying off
exactly where §1.5 said it would. Crop and rotate are the two ops that *do* invalidate a page
bitmap and must trigger a re-render.

## Open design question this phase must answer first

Page state is currently duplicated:

- `apps/web/src/stores/document.ts` — `pageOrder` + `pages[id] = { id, sourceIndex, geometry }`
- `apps/web/src/stores/edits.ts` — `pageOrder` + `pages[id] = { sourceIndex }` (seeded on open)

`PLAN.md` §1.2 specifies `pages[pageId] = { sourceIndex, rotation, cropBox | null }` and says
page-structure ops share the **same linear undo stack** as object ops, so ⌘Z is globally
predictable. Phase 3 therefore has to decide which store owns `pageOrder` and page-level
rotation/crop, and add op types (`rotatePage`, `deletePage`, `reorderPages`, `cropPage`) to
`EditDocument`. That is a schema change, and it is also what makes Task 34 Step 5's deferred
link-adoption tractable — both want `EditDocument` to own more page-level truth.

Objects are keyed by synthetic `pageId` already (§1.2b), so delete and reorder cannot orphan or
misattribute them. That invariant is the reason this phase is 🟢 rather than 🔴.
