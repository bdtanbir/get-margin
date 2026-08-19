# get-margin Phase 3 — Page Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rotate, delete, reorder, crop, extract, split, and merge pages, with every operation on the same undo stack as object edits and every export lossless where losslessness is achievable.

**Architecture:** `EditDocument` grows to own page order and per-page rotation/crop overrides; the document store becomes a registry of opened *sources* and exposes `pages`/`pageOrder` as getters returning **effective** geometry, so all seventeen existing geometry consumers keep working untouched. The write path grows three assembly tiers — byte-identical pass-through, lossless in-place restructuring for a single source, and graft-plus-explicit-`/Annots` for true multi-document merge.

**Tech Stack:** TypeScript, Vue 3 + Pinia, mupdf 1.28.0 (WASM, in a Comlink worker), Immer, Vitest, Playwright. One new runtime dependency: `fflate`.

**Spec:** `PHASE-3-DESIGN.md`. Measurements it argues from: `docs/findings/07-phase-3-preflight.md`.

> ## Status: BUILT, with two things outstanding
>
> Tasks 41–51 are implemented and tested. The step checkboxes below are the historical plan text;
> the authoritative status is here and in `PLAN.md` §7.
>
> **Outstanding:**
> - **Cross-viewer verification** (Acrobat / Preview / Chrome). No GUI here, as in Phase 2. Files
>   and matrix: `docs/findings/08-phase-3-verification.md`.
> - **Page selection is desktop-only.** The phone's pages panel closes when a thumbnail is tapped —
>   deliberate Phase 1 navigation behaviour — which makes tap-to-select unreachable. Merge, split
>   and crop do work on phone. Needs the touch affordance `PHASE-3-DESIGN.md` §6 called for.
>
> **Where the build departed from the plan text**, each commented at the site:
> - Source registration folded INTO the `insertPages` op rather than a second store method, so
>   `applyOp` stays the only writer and undoing a merge removes the source with its pages.
> - `isUntouched` takes the source's page count: without it a 3-page extract of a 12-page document
>   looks untouched, because pages 0,1,2 do sit at positions 0,1,2.
> - One `PDFGraftMap` **per source** — a map is bound to the document it first grafted from.
> - Page selection is a Pinia store, not the module-scope composable the plan sketched.
> - `render()` gained a `sourceId`: it previously always used the primary document, so a merged-in
>   page rendered the wrong file's page silently.

## Global Constraints

Every task's requirements implicitly include this section.

- **Node `>=22`**, pnpm 9.15.0, workspaces `apps/web`, `packages/pdf-core`, `packages/transform`.
- **Four Vitest projects** (`vitest.workspace.ts`): `pdf-core` (node), `transform` (node), `web` (jsdom), `web-node` (node, `test/workers/**`). `e2e/**` is Playwright, excluded from Vitest.
- **`packages/pdf-core` imports use explicit `.js` extensions.** `apps/web` uses the `@/` alias.
- **Disposal is a correctness requirement.** Every `loadPage()` and `toPixmap()` wrapped in `try/finally` with an unconditional `.destroy()`. Omitting it hard-crashes the WASM heap rather than leaking gradually (`docs/findings/00-engine-facts.md`).
- **MuPDF is not reentrant.** The worker's single-threaded event loop is the serialisation mechanism.
- **All stored object geometry is unrotated PDF user space.** Crop and rotate change the page's frame, never an object's `rect`.
- **`setPageBox` is Convention A** — top-down MuPDF page space, like `setRect`. Pass rects through `toAnnotSpace()`, never `toContentSpace()`. See `PHASE-3-DESIGN.md` §1.1.
- **`graftPage` drops `/Annots`.** Any graft must be followed by an explicit `/Annots` graft or the user's existing annotations are destroyed. See `PHASE-3-DESIGN.md` §1.2.
- **Every mutation of `EditDocument` goes through `applyOp`.** No `$patch`, no direct assignment.
- **Honest naming.** Crop *hides*; it does not delete. Merge drops bookmarks. Both said in the UI.
- **Only one new runtime dependency:** `fflate` (Task 49). No zip library with a WASM payload.
- **Commit after every task**, conventional commits scoped `feat(web)`, `feat(pdf-core)`, `fix(web)`, `test(pdf-core)`.

---

## File Structure

**Created in `packages/pdf-core/src/`:**

| File | Responsibility |
|---|---|
| `write/migrate.ts` | `migrateEditDocument(doc)` — v1 → v2, a pure function |
| `write/assemble.ts` | The three assembly tiers. Sole owner of `deletePage`/`insertPage`/`graftPage` |
| `write/objects/page.ts` | Applies per-page `rotation` and `cropBox` after assembly |

**Created in `apps/web/src/`:**

| File | Responsibility |
|---|---|
| `features/pages/PageGrid.vue` | The page-ops surface: select, reorder, rotate, delete |
| `features/pages/usePageSelection.ts` | Multi-select state (view state, never in history) |
| `features/pages/useDragReorder.ts` | Pointer-driven reordering, reusing `useDragGesture` |
| `features/pages/CropOverlay.vue` | Interactive crop rect on a page |
| `features/pages/SplitDialog.vue` | Range entry for extract/split |
| `lib/zip.ts` | `zipFiles(entries)` — `fflate` wrapper |

**Modified:** `write/types.ts` (schema v2, new ops) · `write/index.ts` (`replay` takes sources) · `stores/edits.ts` (page ops) · `stores/document.ts` (source registry + getters) · `workers/pdfService.ts`, `pdfClient.ts` (multi-source) · `features/document/ThumbnailPanel.vue` (hosts `PageGrid`).

---

## Task 41: Schema v2 — sources, page overrides, and migration

The load-bearing change. Everything else depends on these types.

**Files:**
- Modify: `packages/pdf-core/src/write/types.ts`
- Create: `packages/pdf-core/src/write/migrate.ts`
- Test: `packages/pdf-core/test/write/migrate.test.ts`

**Interfaces:**
- Produces: `SourceId`, `PageEntry`, `EditDocument` v2, `EDIT_DOCUMENT_VERSION = 2`, `migrateEditDocument(doc: unknown): EditDocument`, and five new `Op` members.

- [ ] **Step 1: Widen the types**

In `write/types.ts`, replace the `EditDocument` type and bump the version:

```ts
export type SourceId = string

export type PageEntry = {
  sourceId: SourceId
  sourceIndex: number
  /** Added to the source page's own /Rotate. Always normalised to 0/90/180/270. */
  rotation: number
  /**
   * Overrides the source CropBox. RAW PDF user space, like every other rect
   * in this file -- the writer converts to Convention A via toAnnotSpace.
   * null means "use whatever the source page has".
   */
  cropBox: [number, number, number, number] | null
}

export type EditDocument = {
  version: number
  /** One entry per opened file. Merge adds more; a normal document has one. */
  sources: Record<SourceId, { hash: string; name: string }>
  pageOrder: PageId[]
  pages: Record<PageId, PageEntry>
  objects: Record<ObjectId, EditObject>
  nextZ: number
}

export const EDIT_DOCUMENT_VERSION = 2
```

Add to the `Op` union:

```ts
  | { type: 'rotatePage'; pageId: PageId; by: 90 | 180 | 270 }
  | { type: 'deletePages'; pageIds: PageId[] }
  | { type: 'reorderPages'; pageOrder: PageId[] }
  | { type: 'cropPage'; pageId: PageId; cropBox: Rect | null }
  | { type: 'insertPages'; pages: Array<{ id: PageId } & PageEntry>; at: number }
```

- [ ] **Step 2: Write the failing migration test**

Create `packages/pdf-core/test/write/migrate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { migrateEditDocument, LEGACY_SOURCE_ID } from '../../src/write/migrate.js'
import { EDIT_DOCUMENT_VERSION } from '../../src/write/types.js'

const v1 = {
  version: 1,
  sourceHash: 'abc123',
  pageOrder: ['p0', 'p1'],
  pages: { p0: { sourceIndex: 0 }, p1: { sourceIndex: 1 } },
  objects: {},
  nextZ: 1,
}

describe('migrateEditDocument', () => {
  it('lifts a v1 document to the current version', () => {
    expect(migrateEditDocument(v1).version).toBe(EDIT_DOCUMENT_VERSION)
  })

  it('synthesises one source from the old top-level hash', () => {
    const out = migrateEditDocument(v1)
    expect(Object.keys(out.sources)).toEqual([LEGACY_SOURCE_ID])
    expect(out.sources[LEGACY_SOURCE_ID]!.hash).toBe('abc123')
  })

  it('stamps every page with that source and default overrides', () => {
    const out = migrateEditDocument(v1)
    expect(out.pages.p0).toEqual({
      sourceId: LEGACY_SOURCE_ID, sourceIndex: 0, rotation: 0, cropBox: null,
    })
  })

  it('preserves page order and objects untouched', () => {
    const withObject = { ...v1, objects: { o1: { id: 'o1', pageId: 'p0' } } }
    const out = migrateEditDocument(withObject as never)
    expect(out.pageOrder).toEqual(['p0', 'p1'])
    expect(out.objects.o1).toBeDefined()
  })

  it('returns a v2 document unchanged', () => {
    const v2 = migrateEditDocument(v1)
    expect(migrateEditDocument(v2)).toEqual(v2)
  })

  // A newer schema must fail loudly rather than being silently mangled --
  // the same rule replay() already applies to the version field.
  it('refuses a version it does not understand', () => {
    expect(() => migrateEditDocument({ ...v1, version: 99 })).toThrow(/newer version/i)
  })

  it('refuses input that is not an edit document at all', () => {
    expect(() => migrateEditDocument(null)).toThrow()
    expect(() => migrateEditDocument({ nope: true })).toThrow()
  })
})
```

- [ ] **Step 3: Run it — expect FAIL** (`pnpm vitest run --project pdf-core migrate`)

- [ ] **Step 4: Implement the migration**

Create `packages/pdf-core/src/write/migrate.ts`:

```ts
import { EDIT_DOCUMENT_VERSION, type EditDocument, type SourceId } from './types.js'

/**
 * The source id given to a document that predates multi-source support.
 * Stable and deterministic: a v1 document migrated twice produces the same
 * ids, so a re-opened autosave does not orphan its pages.
 */
export const LEGACY_SOURCE_ID: SourceId = 'src-0'

type V1 = {
  version: 1
  sourceHash: string
  pageOrder: string[]
  pages: Record<string, { sourceIndex: number }>
  objects: Record<string, unknown>
  nextZ: number
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * v1 -> v2. A pure function of its input; it never mutates what it is given.
 *
 * v1 had one implicit source identified by a top-level `sourceHash`, and
 * pages carried only a `sourceIndex`. v2 names the source explicitly so that
 * merge can add more, and gives every page its rotation and crop overrides.
 */
export function migrateEditDocument(input: unknown): EditDocument {
  if (!isRecord(input) || typeof input.version !== 'number') {
    throw new Error('That is not an edit document.')
  }
  if (input.version > EDIT_DOCUMENT_VERSION) {
    throw new Error(
      `This document was edited by a newer version of get-margin ` +
        `(schema version ${input.version}, this build understands ${EDIT_DOCUMENT_VERSION}).`,
    )
  }
  if (input.version === EDIT_DOCUMENT_VERSION) return input as unknown as EditDocument

  const doc = input as unknown as V1
  return {
    version: EDIT_DOCUMENT_VERSION,
    sources: { [LEGACY_SOURCE_ID]: { hash: doc.sourceHash ?? '', name: '' } },
    pageOrder: [...doc.pageOrder],
    pages: Object.fromEntries(
      Object.entries(doc.pages).map(([id, p]) => [
        id,
        { sourceId: LEGACY_SOURCE_ID, sourceIndex: p.sourceIndex, rotation: 0, cropBox: null },
      ]),
    ),
    objects: { ...doc.objects } as EditDocument['objects'],
    nextZ: doc.nextZ,
  }
}
```

- [ ] **Step 5: Run it — expect PASS**

- [ ] **Step 6: Export it and fix every compile error the schema change caused**

Add to `write/index.ts`'s export block: `export { migrateEditDocument, LEGACY_SOURCE_ID } from './migrate.js'`.

`pnpm typecheck` will now fail everywhere `EditDocument` is constructed — the existing pdf-core tests build v1-shaped literals. Update each to the v2 shape (`sources`, and `pages[id]` carrying `sourceId`/`rotation`/`cropBox`). Do NOT change what any test asserts; only the fixture shape.

- [ ] **Step 7: Run everything**

Run: `pnpm test && pnpm typecheck`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/pdf-core apps/web
git commit -m "feat(pdf-core): EditDocument schema v2 — sources and page overrides

Merge means sourceIndex alone no longer identifies a page, so pages gain
sourceId, and rotation and cropBox overrides so page ops can share the
object ops' undo stack. migrateEditDocument lifts v1 in one pure pass and
refuses a newer version loudly rather than mangling it."
```

---

## Task 42: Page ops in the edit store

Five ops, one undo stack. The interesting one is `deletePages`, which must take a page's objects with it so `EditDocument` never holds orphans.

**Files:**
- Modify: `apps/web/src/stores/edits.ts`
- Test: `apps/web/test/stores/edits.test.ts`

**Interfaces:**
- Consumes: the v2 `Op` union from Task 41.
- Produces: `reduce` handling all five page ops; `useEditsStore().reset(sources, pageOrder, pages)` with the new signature.

- [ ] **Step 1: Write the failing store tests**

Append to `apps/web/test/stores/edits.test.ts`:

```ts
describe('page operations', () => {
  function seed(): ReturnType<typeof useEditsStore> {
    const s = useEditsStore()
    s.reset(
      { 'src-0': { hash: 'h', name: 'a.pdf' } },
      ['p1', 'p2', 'p3'],
      {
        p1: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null },
        p2: { sourceId: 'src-0', sourceIndex: 1, rotation: 0, cropBox: null },
        p3: { sourceId: 'src-0', sourceIndex: 2, rotation: 0, cropBox: null },
      },
    )
    return s
  }

  it('rotates a page by the given quarter turns', () => {
    const s = seed()
    s.applyOp({ type: 'rotatePage', pageId: 'p2', by: 90 }, 'Rotate')
    expect(s.doc.pages.p2!.rotation).toBe(90)
  })

  it('accumulates rotation and wraps at 360', () => {
    const s = seed()
    for (let i = 0; i < 5; i++) s.applyOp({ type: 'rotatePage', pageId: 'p1', by: 90 }, 'Rotate')
    expect(s.doc.pages.p1!.rotation).toBe(90)
  })

  it('reorders pages', () => {
    const s = seed()
    s.applyOp({ type: 'reorderPages', pageOrder: ['p3', 'p1', 'p2'] }, 'Reorder')
    expect(s.doc.pageOrder).toEqual(['p3', 'p1', 'p2'])
  })

  it('deletes pages from both the order and the map', () => {
    const s = seed()
    s.applyOp({ type: 'deletePages', pageIds: ['p2'] }, 'Delete')
    expect(s.doc.pageOrder).toEqual(['p1', 'p3'])
    expect(s.doc.pages.p2).toBeUndefined()
  })

  // Objects are keyed by pageId. Leaving them behind would make
  // EditDocument hold objects pointing at pages that no longer exist.
  it('takes a deleted page’s objects with it', () => {
    const s = seed()
    s.applyOp({ type: 'addObject', object: rectObject('o1', 'p2') }, 'Add')
    s.applyOp({ type: 'addObject', object: rectObject('o2', 'p1') }, 'Add')
    s.applyOp({ type: 'deletePages', pageIds: ['p2'] }, 'Delete')
    expect(s.doc.objects.o1).toBeUndefined()
    expect(s.doc.objects.o2).toBeDefined()
  })

  // One ⌘Z brings back the page AND the annotations that were on it.
  it('restores a deleted page with its objects in one undo', () => {
    const s = seed()
    s.applyOp({ type: 'addObject', object: rectObject('o1', 'p2') }, 'Add')
    s.applyOp({ type: 'deletePages', pageIds: ['p2'] }, 'Delete')
    s.undo()
    expect(s.doc.pageOrder).toEqual(['p1', 'p2', 'p3'])
    expect(s.doc.objects.o1).toBeDefined()
  })

  it('deletes several pages in one op and one undo step', () => {
    const s = seed()
    const before = s.historySize
    s.applyOp({ type: 'deletePages', pageIds: ['p1', 'p3'] }, 'Delete')
    expect(s.doc.pageOrder).toEqual(['p2'])
    expect(s.historySize).toBe(before + 1)
    s.undo()
    expect(s.doc.pageOrder).toEqual(['p1', 'p2', 'p3'])
  })

  // Deleting the last page would leave a document with nothing to show.
  it('refuses to delete every page', () => {
    const s = seed()
    s.applyOp({ type: 'deletePages', pageIds: ['p1', 'p2', 'p3'] }, 'Delete')
    expect(s.doc.pageOrder).toEqual(['p1', 'p2', 'p3'])
  })

  it('crops a page and clears the crop again', () => {
    const s = seed()
    s.applyOp({ type: 'cropPage', pageId: 'p1', cropBox: { x: 10, y: 20, w: 100, h: 200 } }, 'Crop')
    expect(s.doc.pages.p1!.cropBox).toEqual([10, 20, 110, 220])
    s.applyOp({ type: 'cropPage', pageId: 'p1', cropBox: null }, 'Uncrop')
    expect(s.doc.pages.p1!.cropBox).toBeNull()
  })

  it('inserts pages at a position', () => {
    const s = seed()
    s.applyOp({
      type: 'insertPages',
      at: 1,
      pages: [{ id: 'n1', sourceId: 'src-1', sourceIndex: 0, rotation: 0, cropBox: null }],
    }, 'Insert')
    expect(s.doc.pageOrder).toEqual(['p1', 'n1', 'p2', 'p3'])
    expect(s.doc.pages.n1!.sourceId).toBe('src-1')
  })

  it('appends when inserting past the end', () => {
    const s = seed()
    s.applyOp({
      type: 'insertPages',
      at: 99,
      pages: [{ id: 'n1', sourceId: 'src-1', sourceIndex: 0, rotation: 0, cropBox: null }],
    }, 'Insert')
    expect(s.doc.pageOrder[3]).toBe('n1')
  })

  it('ignores an op naming a page that does not exist', () => {
    const s = seed()
    s.applyOp({ type: 'rotatePage', pageId: 'nope', by: 90 }, 'Rotate')
    expect(s.doc.pageOrder).toEqual(['p1', 'p2', 'p3'])
  })
})
```

`rectObject` already exists at the top of this file but takes `(id, pageId = 'p1')` — it is already parameterised, so no change is needed.

- [ ] **Step 2: Run them — expect FAIL** (`pnpm vitest run --project web test/stores/edits`)

- [ ] **Step 3: Implement the reducer cases**

In `apps/web/src/stores/edits.ts`, extend `reduce`:

```ts
    case 'rotatePage': {
      const page = draft.pages[op.pageId]
      if (!page) return
      // Normalised so the stored value is always one of 0/90/180/270 --
      // an unbounded accumulator would eventually be compared against a
      // normalised source rotation and disagree.
      page.rotation = (((page.rotation + op.by) % 360) + 360) % 360
      break
    }
    case 'reorderPages':
      draft.pageOrder = op.pageOrder.filter((id) => draft.pages[id])
      break
    case 'deletePages': {
      const doomed = new Set(op.pageIds.filter((id) => draft.pages[id]))
      if (doomed.size === 0) return
      // A document with no pages has nothing to render and no way back
      // except undo. Refuse rather than producing that state.
      if (doomed.size >= draft.pageOrder.length) return
      draft.pageOrder = draft.pageOrder.filter((id) => !doomed.has(id))
      for (const id of doomed) delete draft.pages[id]
      // Objects are keyed by pageId; leaving them would orphan them. They
      // come back with the page on undo, because both are in one patch.
      for (const [objectId, object] of Object.entries(draft.objects)) {
        if (doomed.has(object.pageId)) delete draft.objects[objectId]
      }
      break
    }
    case 'cropPage': {
      const page = draft.pages[op.pageId]
      if (!page) return
      // Stored as a PDF rect [x0,y0,x1,y1] to match PageGeometry.cropBox,
      // which is what every consumer of geometry already reads.
      page.cropBox = op.cropBox
        ? [op.cropBox.x, op.cropBox.y, op.cropBox.x + op.cropBox.w, op.cropBox.y + op.cropBox.h]
        : null
      break
    }
    case 'insertPages': {
      const at = Math.max(0, Math.min(op.at, draft.pageOrder.length))
      for (const { id, ...entry } of op.pages) draft.pages[id] = entry
      draft.pageOrder.splice(at, 0, ...op.pages.map((p) => p.id))
      break
    }
```

- [ ] **Step 4: Widen `reset` for sources**

```ts
  function reset(
    sources: EditDocument['sources'],
    pageOrder: string[],
    pages: EditDocument['pages'],
  ): void {
    state.value = { ...emptyDocument(), sources, pageOrder, pages }
    past.value = []
    future.value = []
    selectedIds.value = []
  }
```

and `emptyDocument()` gains `sources: {}` and drops `sourceHash`. Update the existing `reset` calls in `stores/document.ts` and in every test that calls it — the compiler will list them.

- [ ] **Step 5: Run the tests — expect PASS**

- [ ] **Step 6: Run everything and commit**

Run: `pnpm test && pnpm typecheck && pnpm --filter @margin/web typecheck`

```bash
git add apps/web/src/stores/edits.ts apps/web/test/stores/edits.test.ts apps/web/src/stores/document.ts
git commit -m "feat(web): page operations on the edit store's undo stack

Five ops through applyOp, so page structure and object edits share one
linear history and Ctrl+Z is globally predictable.

deletePages takes the page's objects with it -- objects are keyed by
pageId, so leaving them would orphan them -- and Immer's inverse patch
brings page and objects back together in one undo. Deleting every page is
refused: a document with no pages has nothing to render."
```

---

## Task 43: The document store becomes a source registry

The change that keeps the rest of the phase cheap: `doc.pages` and `doc.pageOrder` become getters returning **effective** geometry, so every existing consumer keeps working untouched.

**Files:**
- Modify: `apps/web/src/stores/document.ts`
- Test: `apps/web/test/stores/document.test.ts`

**Interfaces:**
- Produces: `SourceState`, `useDocumentStore().sources`, `addSource(...)`, and `pages`/`pageOrder` as getters. `PageState` keeps its shape — `{ id, sourceIndex, geometry }` — so no consumer changes.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/test/stores/document.test.ts`:

```ts
describe('effective page geometry', () => {
  it('reports the source geometry when nothing overrides it', async () => {
    const doc = useDocumentStore()
    await doc.openFile(fakeFile('a.pdf', PDF_BYTES))
    expect(doc.pages[doc.pageOrder[0]!]!.geometry).toEqual(GEOM)
  })

  // The whole point of the getter: a rotate op must reach every consumer
  // of page.geometry -- PageCanvas, PageOverlay, Thumbnail -- with no
  // change to any of them.
  it('adds the edit rotation to the source rotation', async () => {
    const doc = useDocumentStore()
    const edits = useEditsStore()
    await doc.openFile(fakeFile('a.pdf', PDF_BYTES))
    const id = doc.pageOrder[0]!
    edits.applyOp({ type: 'rotatePage', pageId: id, by: 90 }, 'Rotate')
    expect(doc.pages[id]!.geometry.rotate).toBe(90)
  })

  it('normalises a rotation that wraps past 360', async () => {
    const doc = useDocumentStore()
    const edits = useEditsStore()
    await doc.openFile(fakeFile('a.pdf', PDF_BYTES))
    const id = doc.pageOrder[0]!
    edits.applyOp({ type: 'rotatePage', pageId: id, by: 270 }, 'Rotate')
    edits.applyOp({ type: 'rotatePage', pageId: id, by: 180 }, 'Rotate')
    expect(doc.pages[id]!.geometry.rotate).toBe(90)
  })

  it('prefers the crop override over the source CropBox', async () => {
    const doc = useDocumentStore()
    const edits = useEditsStore()
    await doc.openFile(fakeFile('a.pdf', PDF_BYTES))
    const id = doc.pageOrder[0]!
    edits.applyOp({ type: 'cropPage', pageId: id, cropBox: { x: 10, y: 20, w: 100, h: 200 } }, 'Crop')
    expect(doc.pages[id]!.geometry.cropBox).toEqual([10, 20, 110, 220])
  })

  it('follows the edit store’s page order, not the source order', async () => {
    const doc = useDocumentStore()
    const edits = useEditsStore()
    await doc.openFile(fakeFile('a.pdf', PDF_BYTES))
    const [a, b, c] = doc.pageOrder
    edits.applyOp({ type: 'reorderPages', pageOrder: [c!, a!, b!] }, 'Reorder')
    expect(doc.pageOrder).toEqual([c, a, b])
    expect(doc.pageCount).toBe(3)
  })

  it('drops a deleted page from the getter', async () => {
    const doc = useDocumentStore()
    const edits = useEditsStore()
    await doc.openFile(fakeFile('a.pdf', PDF_BYTES))
    const id = doc.pageOrder[0]!
    edits.applyOp({ type: 'deletePages', pageIds: [id] }, 'Delete')
    expect(doc.pageOrder).not.toContain(id)
    expect(doc.pageCount).toBe(2)
  })

  it('registers the opened file as a source', async () => {
    const doc = useDocumentStore()
    await doc.openFile(fakeFile('contract.pdf', PDF_BYTES))
    const sources = Object.values(doc.sources)
    expect(sources).toHaveLength(1)
    expect(sources[0]!.name).toBe('contract.pdf')
    expect(sources[0]!.geometries).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run them — expect FAIL**

- [ ] **Step 3: Implement the registry and the getters**

Replace the state and add getters in `apps/web/src/stores/document.ts`:

```ts
export type SourceId = string

export type SourceState = {
  id: SourceId
  name: string
  size: number
  hash: string
  pageCount: number
  /** Intrinsic geometry of each page, as the FILE has it. Never mutated. */
  geometries: PageGeometry[]
}

type State = {
  status: DocStatus
  /** The file the user opened first. Merge adds more sources, not more of these. */
  fileName: string
  fileSize: number
  sources: Record<SourceId, SourceState>
  error: string
}
```

The two getters are the whole trick:

```ts
  getters: {
    /**
     * Display order, owned by the EDIT store so that reordering is undoable
     * alongside object edits (PLAN.md 1.2). This getter exists so that
     * PageList, ThumbnailPanel, and every other consumer keep reading
     * `doc.pageOrder` exactly as they did in Phase 1.
     */
    pageOrder(): PageId[] {
      return useEditsStore().doc.pageOrder
    },

    /**
     * EFFECTIVE page state: the source's intrinsic geometry with the edit
     * store's rotation and crop overrides folded in.
     *
     * Returning effective geometry HERE is what keeps Phase 3 cheap --
     * seventeen call sites read `page.geometry` (PageCanvas, PageOverlay,
     * SelectionChrome, useDrawTool, InkCanvas, Thumbnail, ...) and none of
     * them need to know that a rotation or crop was applied.
     */
    pages(): Record<PageId, PageState> {
      const edits = useEditsStore()
      const out: Record<PageId, PageState> = {}
      for (const [id, entry] of Object.entries(edits.doc.pages)) {
        const source = this.sources[entry.sourceId]
        const base = source?.geometries[entry.sourceIndex]
        if (!base) continue
        out[id] = {
          id,
          sourceIndex: entry.sourceIndex,
          geometry: {
            cropBox: entry.cropBox ?? base.cropBox,
            rotate: normalizeRotation(base.rotate + entry.rotation),
          },
        }
      }
      return out
    },

    pageCount(): number {
      return this.pageOrder.length
    },
    isReady(): boolean {
      return this.status === 'ready'
    },
  },
```

Import `normalizeRotation` from `@margin/transform`.

`_applyInfo` becomes `addSource`, which registers the source and seeds the edit store:

```ts
    /**
     * Register an opened file and seed the edit store with one page entry
     * per source page. Returns the new source's id.
     *
     * Page ids are minted HERE, in the one place, and handed straight to
     * the edit store -- deriving them a second time elsewhere is how
     * objects end up attributed to the wrong page (spec 1.2b).
     */
    addSource(info: { name: string; size: number; hash: string; geometries: PageGeometry[] }): SourceId {
      const edits = useEditsStore()
      const id: SourceId = `src-${nanoid(8)}`
      this.sources[id] = {
        id, name: info.name, size: info.size, hash: info.hash,
        pageCount: info.geometries.length, geometries: info.geometries,
      }

      const entries = info.geometries.map((_, i) => ({
        id: nanoid(10),
        sourceId: id,
        sourceIndex: i,
        rotation: 0,
        cropBox: null,
      }))

      if (Object.keys(edits.doc.sources).length === 0) {
        edits.reset(
          { [id]: { hash: info.hash, name: info.name } },
          entries.map((e) => e.id),
          Object.fromEntries(entries.map(({ id: pid, ...rest }) => [pid, rest])),
        )
      } else {
        // Merge path (Task 50): appending a source is an undoable op.
        edits.addSource(id, { hash: info.hash, name: info.name })
        edits.applyOp(
          { type: 'insertPages', at: Number.MAX_SAFE_INTEGER, pages: entries },
          `Add ${info.name}`,
        )
      }
      return id
    },
```

`openFile` calls `addSource` where it used to call `_applyInfo`, and clears `this.sources = {}` where it used to clear `pageOrder`/`pages`.

`edits.addSource(id, meta)` is a small non-undoable registration on the edit store — add it alongside `reset`:

```ts
  /** Register a source. Not an op: a source is a fact about a file, not an edit. */
  function addSource(id: string, meta: { hash: string; name: string }): void {
    state.value = { ...state.value, sources: { ...state.value.sources, [id]: meta } }
  }
```

- [ ] **Step 4: Run the tests — expect PASS**

- [ ] **Step 5: Run everything and commit**

Run: `pnpm test && pnpm typecheck && pnpm --filter @margin/web typecheck && pnpm --filter @margin/web build`

```bash
git add apps/web/src/stores apps/web/test/stores
git commit -m "feat(web): document store becomes a source registry

pageOrder was duplicated across two stores. It now lives in EditDocument,
where it is undoable, and doc.pageOrder/doc.pages are getters over it.

doc.pages returns EFFECTIVE geometry -- the source's intrinsic box with
the edit store's rotation and crop folded in -- so all seventeen existing
readers of page.geometry keep working with no change at all."
```

---

## Task 44: The write path — three assembly tiers

Where the two measured traps land. Read `PHASE-3-DESIGN.md` §1 before starting.

**Files:**
- Create: `packages/pdf-core/src/write/assemble.ts`, `packages/pdf-core/src/write/objects/page.ts`
- Modify: `packages/pdf-core/src/write/index.ts`, `session.ts`
- Test: `packages/pdf-core/test/write/assemble.test.ts`

**Interfaces:**
- Consumes: schema v2 (Task 41).
- Produces: `assemble(sources: Map<SourceId, Uint8Array>, editDoc): { raw: mupdf.PDFDocument; passThrough: Uint8Array | undefined }`; `applyPageBoxes(raw, editDoc)`; `replay(sources: Map<SourceId, Uint8Array>, editDoc, opts?)`.

- [ ] **Step 1: Write the failing assembly tests**

Create `packages/pdf-core/test/write/assemble.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import * as mupdf from 'mupdf'
import { replay } from '../../src/write/index.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument } from '../../src/write/types.js'
import { PdfDocument } from '../../src/index.js'
import { generateFixtures, fixturePath } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: Parameters<typeof fixturePath>[0]): Uint8Array =>
  new Uint8Array(readFileSync(fixturePath(n)))

const SRC = 'src-0'

/** An edit document over one source, with pages in the given source order. */
function doc(order: number[], overrides: Record<number, Partial<{ rotation: number; cropBox: [number,number,number,number] }>> = {}): EditDocument {
  const ids = order.map((i) => `p${i}`)
  return {
    version: EDIT_DOCUMENT_VERSION,
    sources: { [SRC]: { hash: '', name: 'a.pdf' } },
    pageOrder: ids,
    pages: Object.fromEntries(order.map((i) => [
      `p${i}`,
      { sourceId: SRC, sourceIndex: i, rotation: 0, cropBox: null, ...overrides[i] },
    ])),
    objects: {},
    nextZ: 1,
  }
}

const firstLine = (pdf: Uint8Array, i: number): string => {
  const d = PdfDocument.open(pdf)
  try {
    const p = d._raw().loadPage(i)
    try { return p.toStructuredText('').asText().trim().split('\n')[0] ?? '' } finally { p.destroy() }
  } finally { d.close() }
}

const pageCount = (pdf: Uint8Array): number => {
  const d = PdfDocument.open(pdf)
  try { return d.pageCount } finally { d.close() }
}

/** A source page carrying an ink annotation, to prove nothing drops it. */
function annotated(): Uint8Array {
  const raw = mupdf.PDFDocument.openDocument(bytes('multi-page'), 'application/pdf')
  const page = raw.loadPage(0)
  const a = page.createAnnotation('Ink')
  a.setColor([1, 0, 0]); a.setBorderWidth(3)
  a.setInkList([[[100, 100], [200, 150], [300, 100]]]); a.update()
  page.createLink([100, 100, 300, 130], 'https://example.com/')
  const out = raw.saveToBuffer('compress,garbage=compact').asUint8Array()
  page.destroy(); raw.destroy()
  return out
}

const annotsOf = (pdf: Uint8Array, i = 0) => {
  const d = PdfDocument.open(pdf)
  try {
    const p = d._raw().loadPage(i)
    try {
      return { annots: p.getAnnotations().map((a) => a.getType()), links: p.getLinks().map((l) => l.getURI()) }
    } finally { p.destroy() }
  } finally { d.close() }
}

describe('assembly', () => {
  const src = () => new Map([[SRC, bytes('multi-page')]])

  // Tier 1. e2e/download.spec.ts asserts byte identity for an unedited
  // download; that guarantee must survive the schema change.
  it('returns the original bytes when nothing changed', () => {
    const original = bytes('multi-page')
    const all = Array.from({ length: pageCount(original) }, (_, i) => i)
    const out = replay(new Map([[SRC, original]]), doc(all))
    expect(Array.from(out)).toEqual(Array.from(original))
  })

  it('does NOT pass through once a page is deleted', () => {
    const original = bytes('multi-page')
    const out = replay(new Map([[SRC, original]]), doc([0, 1, 2]))
    expect(Array.from(out)).not.toEqual(Array.from(original))
    expect(pageCount(out)).toBe(3)
  })

  // Tier 2.
  it('reorders a single source in place, in the order given', () => {
    const out = replay(src(), doc([2, 0, 1]))
    expect(pageCount(out)).toBe(3)
    expect([0, 1, 2].map((i) => firstLine(out, i))).toEqual(['Page 3', 'Page 1', 'Page 2'])
  })

  it('extracts a subset', () => {
    const out = replay(src(), doc([4, 5]))
    expect(pageCount(out)).toBe(2)
    expect(firstLine(out, 0)).toBe('Page 5')
  })

  // The in-place tier exists BECAUSE it is lossless. If this ever fails,
  // the tier has silently become a graft.
  it('keeps existing annotations and links through a reorder', () => {
    const out = replay(new Map([[SRC, annotated()]]), doc([1, 0]))
    // The annotated page was source page 0, now at index 1.
    expect(annotsOf(out, 1)).toEqual({ annots: ['Ink'], links: ['https://example.com/'] })
  })

  // Tier 3. graftPage drops /Annots -- see PHASE-3-DESIGN.md 1.2. Without
  // the explicit re-graft this test fails and a real user loses their
  // highlights on every merge.
  it('keeps existing annotations and links through a MERGE', () => {
    const two: EditDocument = {
      version: EDIT_DOCUMENT_VERSION,
      sources: { a: { hash: '', name: 'a.pdf' }, b: { hash: '', name: 'b.pdf' } },
      pageOrder: ['x', 'y'],
      pages: {
        x: { sourceId: 'a', sourceIndex: 0, rotation: 0, cropBox: null },
        y: { sourceId: 'b', sourceIndex: 0, rotation: 0, cropBox: null },
      },
      objects: {},
      nextZ: 1,
    }
    const out = replay(new Map([['a', annotated()], ['b', bytes('simple-text')]]), two)
    expect(pageCount(out)).toBe(2)
    expect(annotsOf(out, 0)).toEqual({ annots: ['Ink'], links: ['https://example.com/'] })
  })

  it('merges pages from two sources in the given order', () => {
    const two: EditDocument = {
      version: EDIT_DOCUMENT_VERSION,
      sources: { a: { hash: '', name: 'a.pdf' }, b: { hash: '', name: 'b.pdf' } },
      pageOrder: ['s', 'm1', 'm2'],
      pages: {
        s: { sourceId: 'b', sourceIndex: 0, rotation: 0, cropBox: null },
        m1: { sourceId: 'a', sourceIndex: 1, rotation: 0, cropBox: null },
        m2: { sourceId: 'a', sourceIndex: 0, rotation: 0, cropBox: null },
      },
      objects: {},
      nextZ: 1,
    }
    const out = replay(new Map([['a', bytes('multi-page')], ['b', bytes('simple-text')]]), two)
    expect(pageCount(out)).toBe(3)
    expect(firstLine(out, 0)).toContain('Hello margin')
    expect(firstLine(out, 1)).toBe('Page 2')
    expect(firstLine(out, 2)).toBe('Page 1')
  })

  it('throws by name when a page names a source that was not supplied', () => {
    expect(() => replay(new Map(), doc([0]))).toThrow(/src-0/)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement assembly**

Create `packages/pdf-core/src/write/assemble.ts`:

```ts
import * as mupdf from 'mupdf'
import type { EditDocument, SourceId } from './types.js'

export type SourceBytes = Map<SourceId, Uint8Array>

/** True when the document is one source, in its original order, unmodified. */
export function isUntouched(editDoc: EditDocument): boolean {
  const ids = Object.keys(editDoc.sources)
  if (ids.length !== 1) return false
  return editDoc.pageOrder.every((pageId, i) => {
    const page = editDoc.pages[pageId]
    return !!page && page.sourceIndex === i && page.rotation === 0 && page.cropBox === null
  })
}

function open(sources: SourceBytes, id: SourceId): mupdf.PDFDocument {
  const bytes = sources.get(id)
  if (!bytes) {
    throw new Error(`source "${id}" was not supplied to the export.`)
  }
  return mupdf.PDFDocument.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument
}

/**
 * graftPage copies page CONTENT and nothing else -- the target page's
 * /Annots comes back null, so every highlight, ink stroke, link, and form
 * field already in the source is destroyed (measured:
 * docs/findings/07-phase-3-preflight.md). Grafting the /Annots array
 * explicitly restores them, appearance streams included.
 *
 * Phase 2's own objects are unaffected either way, because they are drawn
 * from EditDocument AFTER assembly -- which is exactly what makes this easy
 * to miss when testing with freshly generated fixtures.
 */
function graftWithAnnots(
  target: mupdf.PDFDocument,
  map: mupdf.PDFGraftMap,
  src: mupdf.PDFDocument,
  srcIndex: number,
  targetIndex: number,
): void {
  target.graftPage(-1, src, srcIndex)
  const srcPage = src.loadPage(srcIndex)
  try {
    const annots = srcPage.getObject().get('Annots')
    if (annots.isArray()) target.findPage(targetIndex).put('Annots', map.graftObject(annots))
  } finally {
    srcPage.destroy()
  }
}

/**
 * Build the document the edit describes, and hand back the open handle.
 *
 * THREE TIERS, in cost order:
 *   1. Untouched single source -> the caller returns the original bytes.
 *   2. Single source, restructured -> unlink and re-insert page objects in
 *      place. Lossless: annotations, links, outlines, and metadata survive.
 *   3. Several sources -> graft, plus the explicit /Annots graft above.
 *      Document-level structure (outlines, page labels) cannot come across.
 *
 * The caller owns the returned document and must destroy it.
 */
export function assemble(sources: SourceBytes, editDoc: EditDocument): mupdf.PDFDocument {
  const sourceIds = Object.keys(editDoc.sources)
  const singleSource = sourceIds.length === 1

  if (singleSource) {
    const only = sourceIds[0]!
    const raw = open(sources, only)
    // findPage BEFORE deleting: deletePage unlinks a page from the tree but
    // leaves the object reachable, so the handles collected here stay valid
    // and can be re-inserted in any order.
    const keep = editDoc.pageOrder.map((pageId) => {
      const page = editDoc.pages[pageId]
      if (!page) throw new Error(`edit document references unknown page "${pageId}"`)
      return raw.findPage(page.sourceIndex)
    })
    for (let i = raw.countPages() - 1; i >= 0; i--) raw.deletePage(i)
    for (const pageObj of keep) raw.insertPage(-1, pageObj)
    return raw
  }

  const target = new mupdf.PDFDocument()
  const map = target.newGraftMap()
  const open_: Map<SourceId, mupdf.PDFDocument> = new Map()
  try {
    editDoc.pageOrder.forEach((pageId, targetIndex) => {
      const page = editDoc.pages[pageId]
      if (!page) throw new Error(`edit document references unknown page "${pageId}"`)
      let src = open_.get(page.sourceId)
      if (!src) {
        src = open(sources, page.sourceId)
        open_.set(page.sourceId, src)
      }
      graftWithAnnots(target, map, src, page.sourceIndex, targetIndex)
    })
  } finally {
    // Sources are opened once each and closed together; a per-page open
    // would reparse a 300-page document once per grafted page.
    for (const d of open_.values()) d.destroy()
  }
  return target
}
```

- [ ] **Step 4: Implement per-page boxes**

Create `packages/pdf-core/src/write/objects/page.ts`:

```ts
import type * as mupdf from 'mupdf'
import type { EditDocument } from '../types.js'
import { toAnnotSpace } from '../coords.js'
import type { PageGeometry } from '@margin/transform'

/**
 * Apply each page's rotation and crop, AFTER assembly and BEFORE objects
 * are drawn.
 *
 * CROP IS CONVENTION A. setPageBox speaks top-down MuPDF page space, like
 * setRect and setQuadPoints -- passing [100,100,400,500] on a 792pt page
 * writes [100,292,400,692] to disk (measured,
 * docs/findings/07-phase-3-preflight.md). A raw bottom-up rect is accepted
 * silently and mirrors the crop vertically, which on a near-symmetric crop
 * looks entirely plausible. Hence toAnnotSpace, and hence a pinning test.
 *
 * Rotation is NOT Convention A -- /Rotate is a plain integer on the page
 * dict, added to whatever the source page already had.
 */
export function applyPageBoxes(
  raw: mupdf.PDFDocument,
  editDoc: EditDocument,
  geometryOf: (index: number) => PageGeometry,
): void {
  editDoc.pageOrder.forEach((pageId, index) => {
    const entry = editDoc.pages[pageId]
    if (!entry) return
    if (entry.rotation === 0 && entry.cropBox === null) return

    const page = raw.loadPage(index)
    try {
      if (entry.cropBox) {
        const [x0, y0, x1, y1] = entry.cropBox
        const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
        page.setPageBox('CropBox', toAnnotSpace(rect, geometryOf(index)))
      }
      if (entry.rotation !== 0) {
        const obj = page.getObject()
        const current = obj.get('Rotate').isNumber() ? obj.get('Rotate').asNumber() : 0
        obj.put('Rotate', (((current + entry.rotation) % 360) + 360) % 360)
      }
    } finally {
      page.destroy()
    }
  })
}
```

- [ ] **Step 5: Rewire `replay`**

In `write/index.ts`: `replay` takes `sources: SourceBytes`, returns the original bytes when `isUntouched(editDoc)` and there are no objects, otherwise `assemble` → `applyPageBoxes` → draw objects → `saveToBuffer`. `withDocument` in `session.ts` gains a sibling that takes an already-open document, so the disposal discipline stays in one place.

Object drawing changes in exactly one way: pages are now addressed by their **position in `pageOrder`**, not by `sourceIndex`, because assembly has already put them in order.

- [ ] **Step 6: Run the tests — expect PASS**

- [ ] **Step 7: Update `PdfService.save` and every caller**

`PdfService` keeps a `Map<SourceId, Uint8Array>` instead of `#sourceBytes`. `save(editDoc, fonts, onProgress)` passes it through. The e2e byte-identity test must still pass.

- [ ] **Step 8: Run everything and commit**

Run: `pnpm test && pnpm typecheck && pnpm --filter @margin/web typecheck`

```bash
git add packages/pdf-core apps/web
git commit -m "feat(pdf-core): three assembly tiers for the write path

Pass-through when nothing changed, so an unedited download is still
byte-identical. In-place unlink/re-insert for a single source, which is
lossless -- annotations, links, outlines and metadata all survive a
reorder. graft plus an EXPLICIT /Annots graft for multi-document merge,
because graftPage copies page content only and drops /Annots entirely;
without that second step every merge destroys the user's existing
highlights and links, silently.

Crop goes through toAnnotSpace: setPageBox is Convention A, and a raw
bottom-up rect mirrors the crop vertically while looking plausible."
```

---

## Task 45: Pinning tests for crop and rotate

The trap from `PHASE-3-DESIGN.md` §1.1, pinned the way Task 24 pinned Convention B. Do not skip this because the crop "looked right" — a mirrored crop looks right on a symmetric page.

**Files:**
- Test: `packages/pdf-core/test/write/pageBoxes.test.ts`

**Interfaces:** consumes `replay` (Task 44).

- [ ] **Step 1: Write the pinning tests**

Create `packages/pdf-core/test/write/pageBoxes.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { replay } from '../../src/write/index.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument } from '../../src/write/types.js'
import { PdfDocument, renderPage } from '../../src/index.js'
import { pdfToView } from '@margin/transform'
import { generateFixtures, fixturePath, type FixtureName } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: FixtureName): Uint8Array => new Uint8Array(readFileSync(fixturePath(n)))
const SRC = 'src-0'

function docWith(pageCount: number, override: Partial<{ rotation: number; cropBox: [number, number, number, number] }>): EditDocument {
  return {
    version: EDIT_DOCUMENT_VERSION,
    sources: { [SRC]: { hash: '', name: 'a.pdf' } },
    pageOrder: Array.from({ length: pageCount }, (_, i) => `p${i}`),
    pages: Object.fromEntries(Array.from({ length: pageCount }, (_, i) => [
      `p${i}`,
      { sourceId: SRC, sourceIndex: i, rotation: 0, cropBox: null, ...(i === 0 ? override : {}) },
    ])),
    objects: {},
    nextZ: 1,
  }
}

const geometryOf = (pdf: Uint8Array, i = 0) => {
  const d = PdfDocument.open(pdf)
  try { return d.pageGeometry(i) } finally { d.close() }
}

describe('crop is Convention A', () => {
  // setPageBox speaks TOP-DOWN page space. A raw bottom-up rect is accepted
  // silently and lands the crop on the mirror image of what the user drew.
  // On a near-symmetric crop that is invisible, which is why this asserts
  // the exact box rather than eyeballing a render.
  it('writes the crop the user drew, not its vertical mirror', () => {
    // Ask for the TOP-LEFT quarter of a 612x792 page, in raw PDF space:
    // x 0..306, y 396..792 (y-up, so the top half is the HIGH y range).
    const out = replay(new Map([[SRC, bytes('simple-text')]]), docWith(1, { cropBox: [0, 396, 306, 792] }))
    expect(geometryOf(out).cropBox).toEqual([0, 396, 306, 792])
  })

  it('crops correctly on a page whose CropBox origin is not zero', () => {
    const src = bytes('offset-cropbox')
    const [x0, y0] = geometryOf(src).cropBox
    const box: [number, number, number, number] = [x0 + 20, y0 + 30, x0 + 120, y0 + 130]
    const out = replay(new Map([[SRC, src]]), docWith(1, { cropBox: box }))
    const got = geometryOf(out).cropBox
    for (let i = 0; i < 4; i++) expect(Math.abs(got[i]! - box[i]!)).toBeLessThan(1)
  })

  it('crops correctly on a quarter-turned page', () => {
    const src = bytes('rotated')
    const doc = docWith(4, {})
    // Page 1 of `rotated` is /Rotate 90. Crop it, not page 0.
    doc.pages.p1 = { sourceId: SRC, sourceIndex: 1, rotation: 0, cropBox: [100, 200, 400, 600] }
    const out = replay(new Map([[SRC, src]]), doc)
    const got = geometryOf(out, 1).cropBox
    for (let i = 0; i < 4; i++) expect(Math.abs(got[i]! - [100, 200, 400, 600][i]!)).toBeLessThan(1)
  })

  // A crop must re-frame the page without moving what is drawn on it.
  it('keeps page content in place, only changing the window', () => {
    const src = bytes('simple-text')
    const out = replay(new Map([[SRC, src]]), docWith(1, { cropBox: [0, 396, 306, 792] }))
    const g = geometryOf(out)
    // "Hello margin" sits near the top of the page and must survive.
    const d = PdfDocument.open(out)
    try {
      const p = d._raw().loadPage(0)
      try { expect(p.toStructuredText('').asJSON()).toContain('Hello margin') } finally { p.destroy() }
    } finally { d.close() }
    expect(g.cropBox[3] - g.cropBox[1]).toBeCloseTo(396, 0)
  })
})

describe('rotate', () => {
  it('adds the edit rotation to the page', () => {
    const out = replay(new Map([[SRC, bytes('simple-text')]]), docWith(1, { rotation: 90 }))
    expect(geometryOf(out).rotate).toBe(90)
  })

  it('adds to a page that is already rotated rather than replacing it', () => {
    const src = bytes('rotated')
    const doc = docWith(4, {})
    // Source page 1 is /Rotate 90; +180 must give 270, not 180.
    doc.pages.p1 = { sourceId: SRC, sourceIndex: 1, rotation: 180, cropBox: null }
    const out = replay(new Map([[SRC, src]]), doc)
    expect(geometryOf(out, 1).rotate).toBe(270)
  })

  it('wraps past 360', () => {
    const src = bytes('rotated')
    const doc = docWith(4, {})
    doc.pages.p3 = { sourceId: SRC, sourceIndex: 3, rotation: 180, cropBox: null }  // 270 + 180
    const out = replay(new Map([[SRC, src]]), doc)
    expect(geometryOf(out, 3).rotate).toBe(90)
  })

  // A rotated page renders with swapped dimensions -- that is the whole
  // observable effect, and what invalidates the cached bitmap.
  it('swaps the rendered dimensions', () => {
    const out = replay(new Map([[SRC, bytes('simple-text')]]), docWith(1, { rotation: 90 }))
    const d = PdfDocument.open(out)
    try {
      const { width, height } = renderPage(d, 0, 1)
      expect(width).toBeGreaterThan(height)
    } finally { d.close() }
  })
})
```

- [ ] **Step 2: Run them**

Run: `pnpm vitest run --project pdf-core pageBoxes`
Expected: PASS. **If the first crop test fails with a vertically mirrored box, the writer is using `toContentSpace` — fix `objects/page.ts`, not the test.**

- [ ] **Step 3: Commit**

```bash
git add packages/pdf-core/test/write/pageBoxes.test.ts
git commit -m "test(pdf-core): pin crop to Convention A and rotation to addition

setPageBox speaks top-down page space; a raw bottom-up rect mirrors the
crop vertically and looks plausible on a symmetric page. Asserted on
origin-zero, offset-CropBox, and quarter-turned pages, plus that rotation
ADDS to a page's existing /Rotate rather than replacing it."
```

---

## Task 46: The page grid — select, rotate, delete

Turns the thumbnails panel into the page-ops surface.

**Files:**
- Create: `apps/web/src/features/pages/PageGrid.vue`, `apps/web/src/features/pages/usePageSelection.ts`
- Modify: `apps/web/src/features/document/ThumbnailPanel.vue`
- Test: `apps/web/test/features/PageGrid.test.ts`

**Interfaces:**
- Consumes: `useDocumentStore().pageOrder/pages` (Task 43), the page ops (Task 42).
- Produces: `usePageSelection()` exposing `selected: PageId[]`, `toggle(id, opts)`, `selectOnly(id)`, `clear()`, `isSelected(id)`.

- [ ] **Step 1: Write the failing selection test**

Create `apps/web/test/features/PageGrid.test.ts` covering: clicking a thumbnail selects only it; ctrl/cmd-click adds to the selection; shift-click selects the range between; the rotate button rotates every selected page in **one** history entry; the delete button deletes every selected page in one entry and clears the selection; and both buttons are absent with no selection.

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import PageGrid from '@/features/pages/PageGrid.vue'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'

const GEOM = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }

function ready(pageCount = 4) {
  const doc = useDocumentStore()
  const edits = useEditsStore()
  const ids = Array.from({ length: pageCount }, (_, i) => `p${i}`)
  doc.$patch({
    status: 'ready',
    sources: { 'src-0': { id: 'src-0', name: 'a.pdf', size: 1, hash: 'h', pageCount, geometries: Array(pageCount).fill(GEOM) } },
  })
  edits.reset(
    { 'src-0': { hash: 'h', name: 'a.pdf' } },
    ids,
    Object.fromEntries(ids.map((id, i) => [id, { sourceId: 'src-0', sourceIndex: i, rotation: 0, cropBox: null }])),
  )
  return { doc, edits, ids }
}

describe('PageGrid', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('renders one tile per page in display order', () => {
    ready()
    expect(mount(PageGrid).findAll('[data-page-tile]')).toHaveLength(4)
  })

  it('selects a single page on click', async () => {
    const { ids } = ready()
    const w = mount(PageGrid)
    await w.get(`[data-page-tile="${ids[1]}"]`).trigger('click')
    expect(w.get(`[data-page-tile="${ids[1]}"]`).attributes('aria-selected')).toBe('true')
    expect(w.get(`[data-page-tile="${ids[0]}"]`).attributes('aria-selected')).toBe('false')
  })

  it('adds to the selection with ctrl-click', async () => {
    const { ids } = ready()
    const w = mount(PageGrid)
    await w.get(`[data-page-tile="${ids[0]}"]`).trigger('click')
    await w.get(`[data-page-tile="${ids[2]}"]`).trigger('click', { ctrlKey: true })
    expect(w.findAll('[aria-selected="true"]')).toHaveLength(2)
  })

  it('selects a range with shift-click', async () => {
    const { ids } = ready()
    const w = mount(PageGrid)
    await w.get(`[data-page-tile="${ids[0]}"]`).trigger('click')
    await w.get(`[data-page-tile="${ids[2]}"]`).trigger('click', { shiftKey: true })
    expect(w.findAll('[aria-selected="true"]')).toHaveLength(3)
  })

  // Rotating four pages is one action to the user, so it is one Ctrl+Z.
  it('rotates every selected page in one history entry', async () => {
    const { edits, ids } = ready()
    const w = mount(PageGrid)
    await w.get(`[data-page-tile="${ids[0]}"]`).trigger('click')
    await w.get(`[data-page-tile="${ids[1]}"]`).trigger('click', { ctrlKey: true })
    const before = edits.historySize
    await w.get('[data-rotate-right]').trigger('click')
    expect(edits.doc.pages[ids[0]!]!.rotation).toBe(90)
    expect(edits.doc.pages[ids[1]!]!.rotation).toBe(90)
    expect(edits.historySize).toBe(before + 1)
  })

  it('deletes every selected page in one entry and clears the selection', async () => {
    const { edits, ids } = ready()
    const w = mount(PageGrid)
    await w.get(`[data-page-tile="${ids[0]}"]`).trigger('click')
    await w.get(`[data-page-tile="${ids[1]}"]`).trigger('click', { ctrlKey: true })
    const before = edits.historySize
    await w.get('[data-delete-pages]').trigger('click')
    expect(edits.doc.pageOrder).toEqual([ids[2], ids[3]])
    expect(edits.historySize).toBe(before + 1)
    expect(w.findAll('[aria-selected="true"]')).toHaveLength(0)
  })

  it('offers no page actions without a selection', () => {
    ready()
    const w = mount(PageGrid)
    expect(w.find('[data-rotate-right]').exists()).toBe(false)
    expect(w.find('[data-delete-pages]').exists()).toBe(false)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement `usePageSelection`**

```ts
import { ref, computed } from 'vue'
import type { PageId } from '@/stores/document'

/**
 * Which pages are selected in the page grid.
 *
 * VIEW STATE. Deliberately not in EditDocument: selecting a page is not an
 * edit, and putting it in history would make every click a Ctrl+Z step.
 * Module-scope so the grid and its toolbar share one selection without
 * prop-drilling, and it survives the panel being collapsed and reopened.
 */
const selected = ref<PageId[]>([])
let anchor: PageId | undefined

export function usePageSelection() {
  function selectOnly(id: PageId): void {
    selected.value = [id]
    anchor = id
  }

  function toggle(id: PageId): void {
    selected.value = selected.value.includes(id)
      ? selected.value.filter((x) => x !== id)
      : [...selected.value, id]
    anchor = id
  }

  /** Inclusive range between the last anchor and `id`, in display order. */
  function extendTo(id: PageId, order: PageId[]): void {
    const from = anchor ? order.indexOf(anchor) : -1
    const to = order.indexOf(id)
    if (from < 0 || to < 0) return selectOnly(id)
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    selected.value = order.slice(lo, hi + 1)
  }

  function clear(): void {
    selected.value = []
    anchor = undefined
  }

  return {
    selected: computed(() => selected.value),
    isSelected: (id: PageId) => selected.value.includes(id),
    selectOnly, toggle, extendTo, clear,
  }
}
```

- [ ] **Step 4: Implement `PageGrid.vue`**

Renders one `[data-page-tile]` per `doc.pageOrder` entry, reusing the existing `Thumbnail.vue` for the image so rendering behaviour is unchanged. Click handler dispatches to `selectOnly` / `toggle` (`e.ctrlKey || e.metaKey`) / `extendTo` (`e.shiftKey`). A toolbar, rendered only when `selected.length > 0`, carries `[data-rotate-left]`, `[data-rotate-right]`, and `[data-delete-pages]`.

Each action is one op over the whole selection, wrapped in `edits.withTransaction` so multiple pages are one undo step:

```ts
function rotate(by: 90 | 270): void {
  const ids = selection.selected.value
  if (ids.length === 0) return
  edits.withTransaction(`Rotate ${ids.length === 1 ? 'page' : 'pages'}`, () => {
    for (const id of ids) edits.applyOp({ type: 'rotatePage', pageId: id, by }, 'Rotate')
    // Crop and rotate are the ONLY edits that change what MuPDF renders,
    // so unlike every Phase 2 op they must drop the cached bitmap.
    for (const id of ids) vp.invalidate(id)
  })
}

function remove(): void {
  const ids = selection.selected.value
  if (ids.length === 0) return
  edits.applyOp({ type: 'deletePages', pageIds: [...ids] }, 'Delete pages')
  selection.clear()
}
```

`withTransaction` is correct here and not `beginTransaction`: the loop is synchronous.

- [ ] **Step 5: Mount it** — `ThumbnailPanel.vue` renders `PageGrid` in place of its current thumbnail list.

- [ ] **Step 6: Run the tests, then everything, then commit**

```bash
git add apps/web/src/features/pages apps/web/src/features/document/ThumbnailPanel.vue apps/web/test/features/PageGrid.test.ts
git commit -m "feat(web): page grid with multi-select, rotate, and delete

Selection is view state, never in EditDocument -- selecting a page is not
an edit. Rotating or deleting a multi-page selection is ONE history entry,
because it is one action to the user. Rotation invalidates the cached
bitmap: crop and rotate are the only edits that change what MuPDF renders."
```

---

## Task 47: Drag to reorder

**Files:**
- Create: `apps/web/src/features/pages/useDragReorder.ts`
- Modify: `apps/web/src/features/pages/PageGrid.vue`
- Test: `apps/web/test/features/useDragReorder.test.ts`

**Interfaces:**
- Consumes: `useDragGesture` (Phase 2, `features/overlay/useDragGesture.ts`).
- Produces: `useDragReorder(order: () => PageId[], commit: (next: PageId[]) => void)` returning `{ onPointerDown, draggingId, dropIndex }`.

- [ ] **Step 1: Write the failing test**

`apps/web/test/features/useDragReorder.test.ts` — pure logic, no DOM. Test `moveTo(order, id, index)` exhaustively, because off-by-one in reordering is the classic bug here:

```ts
import { describe, it, expect } from 'vitest'
import { moveTo } from '@/features/pages/useDragReorder'

describe('moveTo', () => {
  const order = ['a', 'b', 'c', 'd']

  it('moves an item forward', () => {
    expect(moveTo(order, 'a', 2)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves an item backward', () => {
    expect(moveTo(order, 'd', 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('moves to the very start and the very end', () => {
    expect(moveTo(order, 'c', 0)).toEqual(['c', 'a', 'b', 'd'])
    expect(moveTo(order, 'a', 3)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('is a no-op when the item is already at that index', () => {
    expect(moveTo(order, 'b', 1)).toEqual(order)
  })

  it('clamps an index past the end', () => {
    expect(moveTo(order, 'a', 99)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('leaves the order alone for an unknown id', () => {
    expect(moveTo(order, 'zz', 0)).toEqual(order)
  })

  it('never changes the length or loses an item', () => {
    for (let i = 0; i < order.length; i++) {
      for (const id of order) {
        const out = moveTo(order, id, i)
        expect(out).toHaveLength(order.length)
        expect([...out].sort()).toEqual([...order].sort())
      }
    }
  })
})
```

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement**

```ts
/**
 * `order` with `id` moved to `index`, computed against the order with `id`
 * already removed -- which is what makes "drop at position 2" mean the same
 * thing whether the item came from before or after that point. Doing it
 * against the original indices is the classic off-by-one in this feature.
 */
export function moveTo(order: PageId[], id: PageId, index: number): PageId[] {
  const from = order.indexOf(id)
  if (from < 0) return order
  const without = order.filter((x) => x !== id)
  const at = Math.max(0, Math.min(index, without.length))
  const next = [...without.slice(0, at), id, ...without.slice(at)]
  return next.every((x, i) => x === order[i]) ? order : next
}
```

The composable tracks `draggingId` and a live `dropIndex` from the pointer's position over the tiles, and calls `commit(moveTo(...))` on pointerup. Reuse `useDragGesture` rather than adding a second pointer implementation.

- [ ] **Step 4: Wire it into `PageGrid.vue`** — one `reorderPages` op per completed drag, so a drag is one undo step. Show the drop position with an insertion marker rather than animating tiles.

- [ ] **Step 5: Run everything and commit**

```bash
git add apps/web/src/features/pages apps/web/test/features/useDragReorder.test.ts
git commit -m "feat(web): drag to reorder pages

moveTo computes the destination against the order with the dragged page
already removed, so 'drop at position 2' means the same thing whether the
page came from before or after that point -- the classic off-by-one here.
Property-tested that no reorder ever loses or duplicates a page."
```

---

## Task 48: Crop UI

**Files:**
- Create: `apps/web/src/features/pages/CropOverlay.vue`
- Modify: `apps/web/src/stores/tools.ts` (a `crop` tool), `apps/web/src/features/overlay/PageOverlay.vue`
- Test: `apps/web/test/features/CropOverlay.test.ts`

**Interfaces:** consumes `useDragGesture`, `viewRectToPdf`; produces a `cropPage` op.

- [ ] **Step 1: Write the failing test**

Cover: dragging a rect and confirming produces a `cropPage` op whose box is in **raw PDF space**; cancel produces nothing; "apply to all pages" emits one op per page in a single history entry; and the honesty copy is present.

```ts
it('commits the dragged rect in raw PDF space', async () => {
  // View y 100..300 on a 792pt page -> PDF y 492..692.
  const w = mountCrop()
  drag(w, { x: 50, y: 100 }, { x: 250, y: 300 })
  await w.get('[data-crop-apply]').trigger('click')
  expect(edits.doc.pages.p1!.cropBox).toEqual([50, 492, 250, 692])
})

it('applies to every page in one history entry', async () => {
  const w = mountCrop()
  drag(w, { x: 50, y: 100 }, { x: 250, y: 300 })
  await w.get('[data-crop-all]').setValue(true)
  const before = edits.historySize
  await w.get('[data-crop-apply]').trigger('click')
  expect(edits.historySize).toBe(before + 1)
  expect(edits.doc.pages.p2!.cropBox).not.toBeNull()
})

// Crop hides; it does not delete. Same honesty rule as whiteout.
it('says that cropping hides rather than removes', () => {
  expect(mountCrop().text()).toContain('still in the file')
})

it('never says "remove" or "delete" of the hidden content', () => {
  const html = mountCrop().html().replace(/<!--[\s\S]*?-->/g, '').toLowerCase()
  expect(html).not.toContain('removes the content')
})
```

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement `CropOverlay.vue`**

A drag-out rect over the page (reusing `useDragGesture`), converted once on commit via `viewRectToPdf` — no coordinate maths in the component. Confirm/cancel buttons, an "apply to all pages" checkbox, and this copy:

> Cropping hides the area outside the box. The hidden content is still in the file and any PDF tool can bring it back.

On confirm, one `cropPage` op (or one per page inside a `withTransaction` when applying to all), then `vp.invalidate(pageId)` for each affected page — crop changes what MuPDF renders.

- [ ] **Step 4: Run everything and commit**

```bash
git add apps/web/src/features/pages/CropOverlay.vue apps/web/src/stores/tools.ts apps/web/src/features/overlay/PageOverlay.vue apps/web/test/features/CropOverlay.test.ts
git commit -m "feat(web): interactive crop with apply-to-all

The box is converted to raw PDF space once, on commit, through
viewRectToPdf -- no component does its own coordinate maths. Applying to
every page is one history entry, and each affected page's bitmap is
invalidated because crop changes what MuPDF renders.

The UI says cropping HIDES: the content outside the box is still in the
file. Same honesty rule as whiteout, with a test on the copy."
```

---

## Task 49: Extract and split

**Files:**
- Create: `apps/web/src/lib/zip.ts`, `apps/web/src/lib/pageRanges.ts`, `apps/web/src/features/pages/SplitDialog.vue`
- Test: `apps/web/test/lib/pageRanges.test.ts`, `apps/web/test/lib/zip.test.ts`

**Interfaces:**
- Produces: `parseRanges(input: string, pageCount: number): number[][]`, `zipFiles(entries: Array<{ name: string; data: Uint8Array }>): Promise<Uint8Array>`.

- [ ] **Step 1: `pnpm --filter @margin/web add fflate`**

- [ ] **Step 2: Write the failing range-parser test**

Range parsing is where this feature actually goes wrong, so it gets exhaustive coverage:

```ts
import { describe, it, expect } from 'vitest'
import { parseRanges } from '@/lib/pageRanges'

describe('parseRanges', () => {
  it('parses a single page', () => expect(parseRanges('3', 10)).toEqual([[2]]))
  it('parses a range', () => expect(parseRanges('2-4', 10)).toEqual([[1, 2, 3]]))
  it('parses several groups, each its own output file', () => {
    expect(parseRanges('1-2, 5', 10)).toEqual([[0, 1], [4]])
  })
  it('accepts an open-ended range', () => expect(parseRanges('8-', 10)).toEqual([[7, 8, 9]]))
  it('is 1-based on input and 0-based on output', () => expect(parseRanges('1', 10)).toEqual([[0]]))
  it('reverses a descending range rather than returning nothing', () => {
    expect(parseRanges('4-2', 10)).toEqual([[1, 2, 3]])
  })
  it('clamps past the end instead of inventing pages', () => {
    expect(parseRanges('9-99', 10)).toEqual([[8, 9]])
  })
  it('rejects a range starting past the end', () => expect(() => parseRanges('20', 10)).toThrow(/1 and 10/))
  it('rejects page 0 and negatives', () => {
    expect(() => parseRanges('0', 10)).toThrow()
    expect(() => parseRanges('-3', 10)).toThrow()
  })
  it('rejects nonsense', () => expect(() => parseRanges('abc', 10)).toThrow())
  it('rejects an empty input with an actionable message', () => {
    expect(() => parseRanges('   ', 10)).toThrow(/Enter/)
  })
  it('tolerates whitespace around separators', () => {
    expect(parseRanges(' 1 - 2 ,  4 ', 10)).toEqual([[0, 1], [3]])
  })
})
```

- [ ] **Step 3: Implement `parseRanges`, then run the tests**

- [ ] **Step 4: Implement `zipFiles`**

```ts
import { zip } from 'fflate'

/**
 * Bundle several PDFs into one download.
 *
 * One download, not several: Chrome and Safari throttle or block
 * successive programmatic downloads, so a 10-way split silently delivers
 * two files and the user does not find out until they look.
 *
 * Stored, not deflated -- a PDF is already compressed, so deflating it
 * again costs CPU for roughly nothing.
 */
export function zipFiles(entries: Array<{ name: string; data: Uint8Array }>): Promise<Uint8Array> {
  const input = Object.fromEntries(entries.map((e) => [e.name, [e.data, { level: 0 }] as const]))
  return new Promise((resolve, reject) => {
    zip(input, (err, out) => (err ? reject(err) : resolve(out)))
  })
}
```

with a test asserting the archive round-trips through `fflate`'s `unzip` with the right names and bytes.

- [ ] **Step 5: Implement `SplitDialog.vue`**

Range input, a live "3 files: pages 1-2, 3-5, 6-10" summary, and an export that calls `save` once per group with an `EditDocument` whose `pageOrder` is that group's slice — reusing the existing write path rather than adding a second one. Names follow `<stem>-<from>-<to>.pdf`. Extract is the same dialog with a single range, downloading a bare PDF rather than a zip.

- [ ] **Step 6: Run everything and commit**

```bash
git add apps/web/src/lib/zip.ts apps/web/src/lib/pageRanges.ts apps/web/src/features/pages/SplitDialog.vue apps/web/test/lib
git commit -m "feat(web): extract and split, delivered as one zip

Splitting reuses the existing write path once per range rather than
adding a second one. The parts ship as a single zip because browsers
throttle successive programmatic downloads -- a 10-way split otherwise
delivers two files and the user does not notice.

Ranges are stored, not deflated: a PDF is already compressed."
```

---

## Task 50: Merge — several documents open at once

The expensive third of the phase, and the only part that puts more than one document in memory.

**Files:**
- Modify: `apps/web/src/workers/pdfService.ts`, `pdfClient.ts`, `apps/web/src/stores/document.ts`, `apps/web/src/features/pages/PageGrid.vue`
- Create: `apps/web/src/features/pages/AddSourceButton.vue`
- Test: `apps/web/test/workers/pdfService.test.ts`, `apps/web/test/features/merge.test.ts`

**Interfaces:**
- Produces: `PdfService.addSource(bytes): { sourceId, pageCount, geometries }`, `PdfService.dropSource(id)`, and `save` reading from the source map.

- [ ] **Step 1: Write the failing service tests**

```ts
describe('PdfService multi-source', () => {
  it('registers a second source and reports its pages', () => {
    const svc = new PdfService()
    svc.open(bytes('simple-text'))
    const added = svc.addSource(bytes('multi-page'))
    expect(added.pageCount).toBe(12)
    expect(added.geometries).toHaveLength(12)
    expect(added.sourceId).not.toBe('')
  })

  it('keeps every source's bytes for export', () => {
    const svc = new PdfService()
    svc.open(bytes('simple-text'))
    const added = svc.addSource(bytes('multi-page'))
    expect(svc.sourceIds()).toHaveLength(2)
    expect(svc.sourceIds()).toContain(added.sourceId)
  })

  // A merged-away source still costs its full byte payload. Dropping it is
  // the only way back under the 150MB cap.
  it('drops a source and its bytes', () => {
    const svc = new PdfService()
    svc.open(bytes('simple-text'))
    const added = svc.addSource(bytes('multi-page'))
    svc.dropSource(added.sourceId)
    expect(svc.sourceIds()).toHaveLength(1)
  })

  it('refuses a source that is not a PDF', () => {
    const svc = new PdfService()
    svc.open(bytes('simple-text'))
    expect(() => svc.addSource(new Uint8Array([1, 2, 3]))).toThrow()
  })

  it('exports pages drawn from both sources', () => {
    const svc = new PdfService()
    svc.open(bytes('simple-text'))
    const added = svc.addSource(bytes('multi-page'))
    const out = svc.save({ /* two-source EditDocument, one page from each */ })
    expect(out.byteLength).toBeGreaterThan(0)
  })

  it('closes every source, not just the first', () => {
    const svc = new PdfService()
    svc.open(bytes('simple-text'))
    svc.addSource(bytes('multi-page'))
    svc.close()
    expect(svc.sourceIds()).toHaveLength(0)
  })
})
```

Fill the `save` test's `EditDocument` with the two-source literal shape from Task 44's tests — repeated in full rather than referenced, since tasks are read out of order.

- [ ] **Step 2: Run them — expect FAIL**

- [ ] **Step 3: Implement multi-source in `PdfService`**

`#sourceBytes: Uint8Array | undefined` becomes `#sources: Map<SourceId, Uint8Array>`, and `#doc` stays as the **rendered** document (the first source) — rendering is unchanged by merge, because a merged page is rendered from its own source.

```ts
  /**
   * Register another file's bytes for merging. Returns its geometry so the
   * main thread can seed page entries without reopening the file there.
   *
   * The bytes are RETAINED for the lifetime of the merge. Several 150MB
   * documents resident at once is the memory ceiling of this feature, which
   * is why dropSource exists and why the UI offers it.
   */
  addSource(bytes: Uint8Array): { sourceId: SourceId; pageCount: number; geometries: PageGeometry[] } {
    const doc = PdfDocument.open(bytes)
    try {
      const geometries = Array.from({ length: doc.pageCount }, (_, i) => doc.pageGeometry(i))
      const sourceId: SourceId = `src-${this.#nextSource++}`
      this.#sources.set(sourceId, bytes)
      return { sourceId, pageCount: doc.pageCount, geometries }
    } finally {
      doc.close()
    }
  }
```

Rendering a page from a non-primary source needs that source open. Keep a small LRU of at most **two** open `PdfDocument` handles (the primary plus whichever secondary was last rendered) rather than holding every source open — a document handle is the expensive resource, the bytes are not.

- [ ] **Step 4: Implement the UI**

`AddSourceButton.vue` picks a file, validates magic bytes with the existing `looksLikePdf`, checks `checkFileSize`, calls `client.addSource`, then `doc.addSource(...)`, which appends its pages through an `insertPages` op — so **adding a document is undoable**.

`PageGrid` grows a per-source header when `Object.keys(doc.sources).length > 1`, and each tile carries its source's name for screen readers. The merge affordance says:

> Merging keeps each page exactly as it is. Bookmarks and page labels from the added file are not carried over.

- [ ] **Step 5: Run everything and commit**

```bash
git add apps/web/src packages/pdf-core apps/web/test
git commit -m "feat(web): merge — several documents open at once

PdfService holds a map of source bytes rather than one buffer, and at most
two open document handles: a handle is the expensive resource, the bytes
are not. Adding a document is an insertPages op, so a merge is undoable
like any other page operation.

The UI states that bookmarks and page labels do not survive a merge --
graftPage carries no document-level structure, and a silently lost table
of contents is discovered long after the fact."
```

---

## Task 51: Golden suite, e2e, and the phase record

**Files:**
- Create: `packages/pdf-core/test/write/pageOpsSuite.test.ts`, `apps/web/e2e/pages.spec.ts`, `docs/findings/08-phase-3-verification.md`
- Modify: `PLAN.md` §7

- [ ] **Step 1: Write the combined golden test**

One document exercising rotate + crop + reorder + delete + a two-source merge, rendered and compared against reviewed goldens on `simple-text`, `offset-cropbox`, and a quarter-turned page. Assert alongside the goldens that:

- every page kind's annotations survive (the §1.2 regression),
- the page count and order match the edit document,
- export is deterministic and never mutates a source's bytes,
- and **`WRITERS` still covers every `ObjectKind`** — the Phase 2 guard, re-run here because the schema change touched the write path.

**Review every new golden by eye before committing it.** A golden accepted unseen records whatever the code did that day. For the crop goldens specifically, check the crop is on the half of the page the test asked for — a mirrored crop is the failure mode this phase is guarding against, and it looks plausible.

- [ ] **Step 2: Write `apps/web/e2e/pages.spec.ts`**

Open a fixture, reorder two pages by drag, rotate one, delete one, download, and assert the downloaded file reopens with the expected page count. Then a second spec: add a second document, confirm the grid spans both, download, and assert the merged page count. Both must run on the `phone` project too, so use the grid's buttons rather than keyboard shortcuts (`useEditShortcuts` is desktop-only — this is why Phase 2's `edit.spec.ts` drives buttons).

- [ ] **Step 3: Record the phase**

`docs/findings/08-phase-3-verification.md`: what is verified automatically, and the cross-viewer matrix for page ops — a rotated page, a cropped page, and a merged document opened in Acrobat, Preview, and Chrome. Record `NOT VERIFIED` honestly where no agent can check, exactly as `06-phase-2-verification.md` does. Export the sample files to `docs/findings/evidence/phase-3-*.pdf`.

Specifically call out for the human: **does the merged file still show the second document's annotations?** That is the §1.2 regression, and a viewer is the only place a user would notice it.

- [ ] **Step 4: Update `PLAN.md` §7** — mark Phase 3 built, with pointers to the verification record and to anything left outstanding, in the same shape Phase 2 uses.

- [ ] **Step 5: Final full run**

```bash
pnpm test && pnpm typecheck && pnpm --filter @margin/web typecheck && pnpm --filter @margin/web build && pnpm --filter @margin/web e2e
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: full Phase 3 golden suite and verification record"
```

---

## Plan self-review

**Spec coverage — every design section maps to a task:**

| Design section | Tasks |
|---|---|
| §0 merge scope, split output, assembly, ownership, bookmarks | 50 · 49 · 44 · 43 · 50 |
| §1.1 `setPageBox` is Convention A | 44 (writer) · 45 (pinning) |
| §1.2 `graftPage` drops `/Annots` | 44 (`graftWithAnnots`) · 44 and 51 (regression tests) |
| §2 ownership split, effective geometry | 43 |
| §3 schema v2 and migration | 41 |
| §4 five ops and three assembly tiers | 42 · 44 |
| §5 coordinates and invalidation | 45 · 46 (rotate) · 48 (crop) |
| §6 UI surfaces | 46 · 47 · 48 · 49 · 50 |
| §7 honesty — crop hides, merge drops bookmarks | 48 · 50 |
| §8 testing | 45 · 51, plus per-task suites |
| §9 out of scope | stated, no task |

**Type consistency:** `SourceId`, `PageEntry`, and `EditDocument` v2 are defined once in Task 41 and imported everywhere after. `EditDocument['sources']` values are `{ hash, name }` in the edit store and the richer `SourceState` in the document store — deliberately different, and both spelled out in Tasks 41 and 43. `replay`'s first parameter becomes `Map<SourceId, Uint8Array>` in Task 44 and every call site is updated in the same task. `usePageSelection` exposes `selectOnly`/`toggle`/`extendTo`/`clear` in Task 46 and Task 47 consumes only `selected`.

**Known gaps, stated rather than hidden:**

1. **The LRU of open document handles in Task 50 is a design sketch, not a measured figure.** Two handles is a guess that a merge renders from at most two sources at a time. If a merged grid scrolls across many sources it will thrash; measure before tuning.
2. **`insertPage` re-insertion order in Task 44 relies on `deletePage` unlinking rather than destroying the page object.** Verified on `multi-page.pdf` (`docs/findings/07-phase-3-preflight.md`) but not on a document with an unusual page tree. Task 44's tests run it on three fixtures; a fourth failing document would mean falling back to the graft tier for single sources too.
3. **Cross-viewer verification is a human gate**, as it was in Phase 2. Task 51 records it rather than claiming it.
