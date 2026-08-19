# Phase 3 — Page Operations: Design

**Status:** design. The executable task breakdown lands separately in `PLAN-PHASE-3.md`.

**Milestone (PLAN.md §7):** rotate · delete · reorder · crop UI · extract · split · merge (multi-document open) · pages-panel interactions.

**Predecessor:** Phase 2 complete and merged (`18adfa9`) — 551 passing tests, 26 e2e, clean `tsc`/`vue-tsc`, 7 reviewed goldens. Every object kind exports correctly on unrotated, offset-CropBox, and quarter-turned pages. Nothing in Phase 2 is being reworked; the write path is extended, not replaced.

**Pre-flight measurements:** `docs/findings/07-phase-3-preflight.md`. Every MuPDF call this phase depends on was run against real fixtures before this design was written. Two of them behaved differently from the obvious assumption, and both shape the design below.

---

## 0. Decisions taken in this design round

| Decision | Choice | Why |
|---|---|---|
| **Merge scope** | Full multi-document in Phase 3 | It is what PLAN.md §7 lists, and `graftPage` is verified working. It is also the expensive third of the phase and the only part that puts several documents in memory at once. |
| **Split output** | One `.zip`, via `fflate` | Chrome and Safari throttle or block successive programmatic downloads, so a 10-way split silently delivers two files — a failure the user does not notice. One download is one file. `fflate` is ~10KB and needs no WASM. |
| **Assembly** | Three tiers: pass-through · in-place · graft | Measured. In-place is lossless; grafting is not, and is used only where it is unavoidable. See §4. |
| **Page-state ownership** | `EditDocument` owns order and overrides; the document store owns sources | PLAN.md §1.2 requires page ops to share the object ops' single undo stack so ⌘Z is globally predictable. Only the edit store has that stack. |
| **Bookmarks across merge** | Lost, and said so in the UI | `graftPage` carries no document-level structure. Silently dropping a table of contents is the same class of failure as a partial export. |

---

## 1. The two traps, measured

### 1.1 `setPageBox` takes Convention A, not raw PDF space

```js
page.setPageBox('CropBox', [100, 100, 400, 500])   // on a 792pt-tall page
// raw /CropBox written to disk: [100, 292, 400, 692]
```

`792 − 500 = 292`, `792 − 100 = 692`. `setPageBox` speaks **MuPDF page space** — top-down, CropBox-origin normalised, `/Rotate` applied — exactly like `setRect` and `setQuadPoints`. This is Convention A from `write/coords.ts`, and the crop writer must therefore pass its rect through the existing `toAnnotSpace()`.

A raw bottom-up rect is accepted silently and produces a vertically mirrored crop. On a near-symmetric crop that looks entirely plausible, which is why this gets a pinning test rather than an eyeball.

### 1.2 `graftPage` silently drops annotations and links

Verified with the source proved to hold them first:

| Stage | Annotations | Links |
|---|---|---|
| Source page | `['Ink']` | `['https://example.com/']` |
| After `graftPage` | `[]` | `[]` — raw `/Annots` is `null` |
| After an in-place re-save | `['Ink']` | `['https://example.com/']` |

`graftPage` copies page **content** and nothing else. A merge built naively on it destroys every highlight, ink stroke, link, and form field already in the user's file.

Phase 2's own objects are unaffected — they are drawn from `EditDocument` *after* assembly — which is precisely what makes this easy to miss when testing with freshly generated fixtures. The regression test for it must use a source that already carries annotations.

The fix, also verified: graft the page, then graft its `/Annots` array explicitly.

```js
const map = target.newGraftMap()
target.graftPage(-1, src, srcIndex)
const annots = srcPage.getObject().get('Annots')
if (annots.isArray()) target.findPage(targetIndex).put('Annots', map.graftObject(annots))
```

The Ink annotation returns with its stroke list and its `/AP` intact; the link with its URI.

---

## 2. Architecture: who owns what

Today `pageOrder` is duplicated — the document store has one and `EditDocument` has another, seeded on open. Phase 3 resolves the duplication by splitting on **mutability**.

```
  stores/document.ts          SOURCES — facts about opened files.
    sources: Record<SourceId, {              Never undoable. One entry per
      name, size, hash, pageCount,           document the user has opened;
      geometries: PageGeometry[]             merge adds more.
    }>
        │
        │  doc.pages / doc.pageOrder become GETTERS
        ▼
  stores/edits.ts             THE EDIT — fully undoable, one linear stack.
    EditDocument.pageOrder                   Order, rotation, crop, objects.
    EditDocument.pages[id] = {
      sourceId, sourceIndex,
      rotation, cropBox | null
    }
```

**The seam that keeps this cheap.** Every consumer in the app — `PageCanvas`, `PageOverlay`, `SelectionChrome`, `useDrawTool`, `InkCanvas`, `Thumbnail`, `PageList` — reads `page.geometry` off a `PageState`. If `doc.pages[id].geometry` returns the **effective** geometry rather than the source's, all seventeen call sites keep working untouched:

```ts
effective = {
  cropBox: override.cropBox ?? source.geometries[sourceIndex].cropBox,
  rotate: normalizeRotation(source.geometries[sourceIndex].rotate + override.rotation),
}
```

`doc.pages` and `doc.pageOrder` therefore become **getters** derived from the edit store plus the source registry. `document.ts` already imports `edits.ts`; the dependency stays one-way.

---

## 3. Schema v1 → v2

Merge means `sourceIndex` alone no longer identifies a page.

```ts
export type SourceId = string

export type EditDocument = {
  version: 2
  sources: Record<SourceId, { hash: string; name: string }>
  pageOrder: PageId[]
  pages: Record<PageId, {
    sourceId: SourceId
    sourceIndex: number
    /** Added to the source page's own /Rotate. Always a multiple of 90. */
    rotation: number
    /** Overrides the source CropBox. Raw PDF space, like every rect. null = use the source's. */
    cropBox: [number, number, number, number] | null
  }>
  objects: Record<ObjectId, EditObject>
  nextZ: number
}
```

`sourceHash` at the document level is replaced by the per-source hash. A v1 document migrates by synthesising a single source from its `sourceHash` and stamping `sourceId` onto every page — a pure function, tested both directions.

`replay(sourceBytes, editDoc, opts)` becomes `replay(sources: Map<SourceId, Uint8Array>, editDoc, opts)`. This is the second widening of that signature and, like Task 31's, every existing behaviour is preserved: a single-source document is a one-entry map.

---

## 4. New ops, and the assembly they drive

All five go through `applyOp`, so they land on the same undo stack as object edits.

```ts
| { type: 'rotatePage'; pageId: PageId; by: 90 | 180 | 270 }
| { type: 'deletePages'; pageIds: PageId[] }
| { type: 'reorderPages'; pageOrder: PageId[] }
| { type: 'cropPage'; pageId: PageId; cropBox: Rect | null }
| { type: 'insertPages'; pages: PageEntry[]; at: number }
```

`deletePages` removes the pages **and their objects** in one op, so `EditDocument` never holds objects pointing at pages that are gone. Immer's inverse patch restores both together, so one ⌘Z brings back the page with its annotations on it.

### Assembly tiers

| Case | Method | Property |
|---|---|---|
| No structural change, no objects | Return the original bytes | Preserves the byte-identity `e2e/download.spec.ts` asserts |
| Single source, reordered / deleted / extracted | `findPage` each kept page → `deletePage` all → `insertPage(-1, obj)` in the new order | Lossless: annotations, links, outlines, metadata all survive |
| Multiple sources | `graftPage` **plus** the explicit `/Annots` graft from §1.2 | The only way to combine documents. Document-level structure is still lost. |

Rotation and crop are applied after assembly, per page; objects are drawn last, unchanged from Phase 2.

---

## 5. Coordinates and invalidation

**Objects do not move.** A crop changes the visible window, not the content stream, and every `EditObject.rect` is raw PDF user space. `svgViewBox`/`svgRootTransform` already subtract the CropBox origin and apply `/Rotate`, so a cropped or rotated page re-frames itself and its objects follow. This is the deferred-bake architecture paying off exactly where §1.5 predicted.

**These two ops are the exception to "edits never invalidate a bitmap".** Crop and rotate change what MuPDF renders, so both must call the viewport store's existing `invalidate(pageId)`. Every Phase 2 edit deliberately did not; these must.

---

## 6. UI surfaces

- **Thumbnails panel becomes the page-ops surface.** Multi-select, drag-to-reorder, and per-page rotate/delete. With more than one source open it grows a per-source header.
- **Crop** is an interactive rect on the page itself, with apply-to-all-pages.
- **Extract / split** is a range dialog; split downloads one `.zip`.
- **Merge** is an "Add PDF…" action that registers another source and appends its pages.

Mobile gets the same operations through the existing full-screen Pages modal; drag-reorder needs a touch-friendly affordance rather than a hover-only handle.

---

## 7. Honesty

**Crop hides; it does not delete.** Content outside the CropBox is still in the file and any PDF tool can recover it. This is the same trap as whiteout and gets the same treatment: the UI says so in plain words, and a test asserts the copy exists. It is not "remove"; real removal is Phase 6.

**A merge drops bookmarks.** Said in the merge UI, because a silently lost table of contents is discovered long after the fact.

---

## 8. Testing

| Layer | What |
|---|---|
| Pinning | `setPageBox` is Convention A — a crop lands where the UI drew it, on origin-zero, offset-CropBox, and rotated pages |
| Regression | Annotations survive a single-source reorder **and** a multi-source merge, from a source that already has them |
| Golden | Rotate, crop, extract, and a two-source merge, each reviewed by eye |
| Store | Every op undoes in one step; deleting a page restores its objects with it |
| e2e | Reorder then download; merge then download; the downloaded file reopens with the expected page count and order |

---

## 9. Explicitly out of scope

- **Outlines/bookmarks and page labels across a merge** — `graftPage` cannot carry them. Stated in the UI, not silently dropped.
- **Snapping and alignment guides** — still Phase 4, unchanged from Phase 2's deferral.
- **Adopting a document's existing links into the edit store** — Phase 2's Task 34 Step 5, still deferred. The schema change here makes it tractable later, since `EditDocument` now owns more page-level truth.
- **Page-level undo across a document close** — history is per-session, as in Phase 2.
