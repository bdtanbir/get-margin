# get-margin Phase 2 — Edit Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase 1 read-only viewer into an editor — place text, images, shapes, whiteout, links, freehand ink, and signatures on a PDF, highlight its text, undo any of it, and download a file that opens correctly in Acrobat, Preview, and Chrome.

**Architecture:** A new Pinia store (`stores/edits.ts`) owns a plain serialisable `EditDocument`; every mutation goes through a single `applyOp` using Immer's `produceWithPatches`, so undo/redo comes from inverse patches rather than hand-written inverters. An SVG overlay per visible page renders objects at their raw stored PDF coordinates, using the already-property-tested `svgViewBox`/`svgRootTransform` from `@margin/transform`. Export is a pure function `replay(sourceBytes, editDocument) -> Uint8Array` running in the worker against a pristine retained copy of the source file, so the viewing document is never mutated and page bitmaps are never invalidated.

**Tech Stack:** Vue 3.5 (setup SFCs) · Pinia 2 (setup stores) · Immer · Tailwind 4 · Comlink worker · mupdf 1.28 · perfect-freehand · Dexie · Vitest (4 projects) · Playwright · pngjs + pixelmatch golden rig

**Spec:** `PHASE-2-DESIGN.md` (repo root). Read it before Task 22 — §3 in particular. Broader product context lives in `PLAN.md` §1.2–1.5, §2.1, §2.5; measured engine behaviour lives in `docs/findings/`.

**Predecessor:** Phase 1, merged at `c6cd91a`. 196 tests passing, `tsc` and `vue-tsc` clean. Nothing in Phase 1 is reworked by this plan.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Node `>=22`** (`package.json` `engines`). The dev shell has been observed on v20.16.0, which pnpm warns about on every command. Task 22 pins `.nvmrc`.
- **pnpm 9.15.0**, workspaces: `apps/web`, `packages/pdf-core`, `packages/transform`.
- **Four Vitest projects** (`vitest.workspace.ts`): `pdf-core` (node), `transform` (node), `web` (jsdom, `@` alias, `test/setup.ts`), `web-node` (node, `test/workers/**` only). Put each test in the project whose environment it needs. `e2e/**` is excluded from Vitest and belongs to Playwright.
- **`packages/pdf-core` imports use explicit `.js` extensions** (`./engine.js`). `apps/web` uses the `@/` alias. Follow the file you are editing.
- **Disposal is a correctness requirement, not hygiene.** Every `loadPage()` and `toPixmap()` must be wrapped in `try/finally` calling `.destroy()` unconditionally. Phase 0 measured that omitting it does not leak gradually — it hard-crashes the WASM heap with `malloc failed` inside a single few-hundred-page sweep (`docs/findings/00-engine-facts.md`).
- **MuPDF is not reentrant.** The worker's single-threaded event loop is the serialisation mechanism. Never issue overlapping calls into `PdfService`.
- **All stored geometry is unrotated PDF user space** — origin bottom-left, y-up, 72dpi points. Zoom and page rotation are view state and never enter `EditDocument`.
- **No component performs its own coordinate arithmetic.** `@margin/transform` owns view-space maths; `pdf-core/src/write/coords.ts` owns write-space maths.
- **Every mutation of `EditDocument` goes through `applyOp`.** No `$patch`, no direct assignment, no second write path.
- **New runtime dependencies this phase, and only these:** `immer` (Task 23), `perfect-freehand` (Task 33), `dexie` (Task 35). `pdf-lib` and `@pdf-lib/fontkit` are explicitly NOT added — font subsetting is Phase 4.
- **Honest naming.** The whiteout tool is called "Whiteout" and its UI says it *covers* content and does not remove it. Never label it "redact" or imply removal. Real redaction is Phase 6.
- **Commit after every task.** Conventional commits, scoped `feat(web)`, `feat(pdf-core)`, `fix(web)`, `test(pdf-core)`, matching Phase 1's history.

---

## File Structure

**Created in `packages/pdf-core/src/`:**

| File | Responsibility |
|---|---|
| `write/index.ts` | `replay(sourceBytes, editDoc)` — the only public entry to the write path |
| `write/session.ts` | Open/dispose lifecycle. Owns the `try/finally .destroy()` discipline so no writer can forget it |
| `write/coords.ts` | The two coordinate conventions (design §3). Sole owner of write-space maths |
| `write/content.ts` | Content-stream drawing primitives: path, text, image |
| `write/annots.ts` | Native annotation primitives: markup quads, ink |
| `write/links.ts` | `page.createLink` + URL validation |
| `write/types.ts` | `EditDocument`, `EditObject`, `ObjectKind` — shared by store and writers |
| `write/objects/*.ts` | One writer per `ObjectKind`. Holds per-kind rules, calls the primitives above, never touches MuPDF directly |
| `text/index.ts` | `buildQuadIndex(doc, pageIndex)` — per-page text quads for selection |

**Created in `apps/web/src/`:**

| File | Responsibility |
|---|---|
| `stores/edits.ts` | `EditDocument` + `applyOp` + history. The only writer |
| `stores/tools.ts` | Active tool and tool-local transient state (never enters history) |
| `features/overlay/PageOverlay.vue` | The SVG layer for one page |
| `features/overlay/ObjectLayer.vue` | Declarative object rendering inside the overlay |
| `features/overlay/SelectionChrome.vue` | DOM handles: drag, resize, rotate |
| `features/overlay/TextEditor.vue` | Absolutely-positioned `contenteditable` |
| `features/overlay/InkCanvas.vue` | Transient canvas for in-flight strokes |
| `features/overlay/objects/*.vue` | One presentational component per `ObjectKind` |
| `features/tools/ToolRail.vue` | Desktop 64px rail (`DesktopShell.vue:35` slot) |
| `features/tools/ToolStrip.vue` | Mobile scrollable strip (`MobileShell.vue:50` slot) |
| `features/tools/Inspector.vue` | Desktop 320px panel (`DesktopShell.vue:63` slot) |
| `features/tools/InspectorSheet.vue` | Mobile bottom sheet |
| `features/tools/SelectionToolbar.vue` | Floating toolbar following the selection |
| `features/signature/SignatureModal.vue` | Draw / type / upload |
| `features/signature/removeBackground.ts` | Luminance threshold → alpha |
| `lib/fonts.ts` | `FontFace` loading + `measureText`, preview↔export parity |
| `lib/exportFile.ts` | `Uint8Array` → Blob → browser download |

**Modified:**

| File | Change |
|---|---|
| `apps/web/src/workers/pdfService.ts` | Retain `#sourceBytes`; add `save(editDoc?)` |
| `apps/web/src/workers/pdfClient.ts` | Add `save` to the `PdfClient` type and implementation |
| `apps/web/src/app/TopBar.vue` | Remove `disabled`, wire Download, add a Tooltip |
| `apps/web/src/app/layouts/DesktopShell.vue` | Mount `ToolRail` (line 35) and `Inspector` (line 63) |
| `apps/web/src/app/layouts/MobileShell.vue` | Mount `ToolStrip` (line 50) and `InspectorSheet` |
| `apps/web/src/features/viewport/PageList.vue` | Mount `PageOverlay` alongside `PageCanvas` |
| `packages/pdf-core/src/index.ts` | Export the write path and text index |

---

## Task 22: Source retention, `PdfService.save()`, and a working Download

The smallest change that makes the Download button do something real. No edits exist yet, so `save()` returns the user's original bytes untouched — which is both the correct behaviour for an unedited document and the foundation the replay path plugs into at Task 24.

**Files:**
- Modify: `apps/web/src/workers/pdfService.ts`
- Modify: `apps/web/src/workers/pdfClient.ts:13-40` (the `PdfClient` type) and its returned object
- Modify: `apps/web/src/app/TopBar.vue:42-56`
- Create: `apps/web/src/lib/exportFile.ts`
- Create: `.nvmrc`
- Test: `apps/web/test/workers/pdfService.test.ts` (extend), `apps/web/test/lib/exportFile.test.ts`, `apps/web/e2e/download.spec.ts`

**Interfaces:**
- Consumes: `PdfService` (existing), `PdfDocument.open` from `@margin/pdf-core`
- Produces:
  - `PdfService.save(): Uint8Array`
  - `PdfClient.save(): Promise<Uint8Array>`
  - `downloadBytes(bytes: Uint8Array, fileName: string): void` from `@/lib/exportFile`

- [ ] **Step 1: Pin the Node version**

Create `.nvmrc`:

```
22
```

- [ ] **Step 2: Write the failing service test**

Append to `apps/web/test/workers/pdfService.test.ts`:

```ts
describe('PdfService.save', () => {
  it('returns the exact source bytes for an unedited document', () => {
    const svc = new PdfService()
    const src = bytes('simple-text')
    svc.open(src.slice())
    expect(Array.from(svc.save())).toEqual(Array.from(src))
  })

  // Guards against a future transfer handler neutering the worker's own
  // copy on the way out. If save() ever hands back the retained buffer as a
  // Transferable, the SECOND call throws or returns an empty array.
  it('can be called twice', () => {
    const svc = new PdfService()
    svc.open(bytes('simple-text'))
    const a = svc.save()
    const b = svc.save()
    expect(a.byteLength).toBeGreaterThan(0)
    expect(Array.from(b)).toEqual(Array.from(a))
  })

  it('throws when no document is open', () => {
    expect(() => new PdfService().save()).toThrow('no document open')
  })

  it('drops the retained bytes on close', () => {
    const svc = new PdfService()
    svc.open(bytes('simple-text'))
    svc.close()
    expect(() => svc.save()).toThrow('no document open')
  })
})
```

The `bytes()` helper already exists at the top of that file — `const bytes = (n) => new Uint8Array(readFileSync(fixturePath(n)))`. Reuse it rather than adding a second one, and note it takes a fixture name **without** the `.pdf` extension.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run --project web-node pdfService`
Expected: FAIL — `svc.save is not a function`

- [ ] **Step 4: Implement source retention and `save()`**

In `apps/web/src/workers/pdfService.ts`, add the field and method to `PdfService`:

```ts
export class PdfService {
  #doc: PdfDocument | undefined
  /**
   * A pristine copy of the file the user opened, retained for the whole
   * lifetime of the open document.
   *
   * This is what makes export a pure function of (sourceBytes, EditDocument):
   * `replay()` (Task 24) builds a SECOND document from these bytes and never
   * touches `#doc`, which is what keeps spec §1.5's deferred-bake invariant
   * true — an edit never invalidates a page bitmap, because the document
   * being rendered is never modified.
   *
   * Costs one extra resident copy of the file. `bytes` was transferred into
   * this worker by pdfClient, so retaining the reference is free; it is not
   * a second copy of anything the main thread still holds.
   */
  #sourceBytes: Uint8Array | undefined

  open(bytes: Uint8Array): DocumentInfo {
    this.close()
    this.#sourceBytes = bytes
    this.#doc = PdfDocument.open(bytes)
    return this.#info()
  }

  /**
   * The exported document.
   *
   * With no edits (Phase 2 Task 22) this is byte-for-byte the file the user
   * opened — not a MuPDF re-serialisation, which would silently change file
   * size and metadata on a document nobody edited. Task 24 replaces the body
   * with `replay(src, editDoc)` while keeping this exact signature.
   *
   * Returned by structured clone, not transfer: the `renderResult` handler in
   * transferHandlers.ts only matches objects carrying an `rgba` field, so a
   * bare Uint8Array is copied across the boundary and `#sourceBytes` survives.
   * The "can be called twice" test pins that.
   */
  save(): Uint8Array {
    const src = this.#sourceBytes
    if (!src) throw new Error('no document open')
    return src
  }

  close(): void {
    this.#doc?.close()
    this.#doc = undefined
    this.#sourceBytes = undefined
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run --project web-node pdfService`
Expected: PASS

- [ ] **Step 6: Write the failing download-helper test**

Create `apps/web/test/lib/exportFile.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { downloadBytes } from '@/lib/exportFile'

describe('downloadBytes', () => {
  let createdUrl: string
  let revoked: string[]

  beforeEach(() => {
    createdUrl = 'blob:mock-url'
    revoked = []
    URL.createObjectURL = vi.fn(() => createdUrl)
    URL.revokeObjectURL = vi.fn((u: string) => void revoked.push(u))
  })

  afterEach(() => vi.restoreAllMocks())

  it('clicks an anchor carrying the given file name', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    downloadBytes(new Uint8Array([1, 2, 3]), 'report.pdf')
    expect(click).toHaveBeenCalledTimes(1)
    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toBe('report.pdf')
    expect(anchor.href).toContain(createdUrl)
  })

  it('revokes the object URL so the blob is not retained', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    downloadBytes(new Uint8Array([1]), 'a.pdf')
    expect(revoked).toEqual([createdUrl])
  })

  it('leaves no anchor behind in the document', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    downloadBytes(new Uint8Array([1]), 'a.pdf')
    expect(document.querySelectorAll('a[download]')).toHaveLength(0)
  })
})
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm vitest run --project web exportFile`
Expected: FAIL — cannot resolve `@/lib/exportFile`

- [ ] **Step 8: Implement the download helper**

Create `apps/web/src/lib/exportFile.ts`:

```ts
/**
 * Hand a byte array to the browser as a file download.
 *
 * Deliberately synchronous and DOM-only: this must run inside the user
 * gesture that triggered it, or Safari blocks the download. Do not await
 * anything between the click handler and this call — await the bytes first,
 * then call this.
 */
export function downloadBytes(bytes: Uint8Array, fileName: string): void {
  // `new Blob([bytes])` would keep a reference to the underlying ArrayBuffer;
  // copying into a fresh view keeps the blob independent of any typed array
  // the caller might still mutate.
  const blob = new Blob([bytes.slice()], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  // Never appended to the document: an unattached anchor still dispatches a
  // download on .click(), and not attaching it means no cleanup step can be
  // skipped and no stray node can survive an exception below.
  try {
    a.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** `report.docx` -> `report.pdf`; `report` -> `report.pdf`. */
export function pdfFileName(sourceName: string): string {
  const base = sourceName.replace(/\.[^./\\]+$/, '')
  return `${base || 'document'}.pdf`
}
```

- [ ] **Step 9: Run it to verify it passes**

Run: `pnpm vitest run --project web exportFile`
Expected: PASS

- [ ] **Step 10: Add `save` to the client**

In `apps/web/src/workers/pdfClient.ts`, add to the `PdfClient` type after `render`:

```ts
  /** The exported document's bytes. See PdfService.save. */
  save(): Promise<Uint8Array>
```

and to the returned object, after `render`:

```ts
    async save() {
      await ready
      return remote.save()
    },
```

- [ ] **Step 11: Wire the Download button**

In `apps/web/src/app/TopBar.vue`, replace the disabled button and its comment block with:

```vue
<Tooltip content="Download PDF" side="bottom">
  <Button
    variant="primary"
    size="sm"
    aria-label="Download"
    :loading="saving"
    :disabled="!doc.isReady"
    @click="download"
  >
    <Download :size="15" :stroke-width="1.5" />
    <span v-if="!props.compact">Download</span>
  </Button>
</Tooltip>
```

and add to the `<script setup>` block:

```ts
import { ref } from 'vue'
import { getPdfClient } from '@/workers/pdfClient'
import { downloadBytes, pdfFileName } from '@/lib/exportFile'

const saving = ref(false)

async function download(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    const bytes = await getPdfClient().save()
    downloadBytes(bytes, pdfFileName(doc.fileName))
  } catch (e) {
    doc.error = e instanceof Error ? e.message : 'Could not export this PDF.'
  } finally {
    saving.value = false
  }
}
```

Note the `aria-label` stays: `compact` mode drops the visible text, and every other control in this header carries an accessible name.

- [ ] **Step 12: Write the end-to-end proof**

Create `apps/web/e2e/download.spec.ts`:

```ts
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/simple-text.pdf', import.meta.url),
)

test('downloads an unedited document byte-for-byte', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('input[type=file]', FIXTURE)
  await expect(page.getByRole('img', { name: 'Page 1' })).toBeVisible()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download' }).click(),
  ])

  expect(download.suggestedFilename()).toBe('simple-text.pdf')
  const path = await download.path()
  expect(readFileSync(path!).equals(readFileSync(FIXTURE))).toBe(true)
})
```

- [ ] **Step 13: Run the whole suite**

Run: `pnpm test && pnpm --filter @margin/web typecheck && pnpm --filter @margin/web e2e download`
Expected: all pass. 196 prior tests still green.

- [ ] **Step 14: Commit**

```bash
git add .nvmrc apps/web/src/lib/exportFile.ts apps/web/src/workers apps/web/src/app/TopBar.vue apps/web/test apps/web/e2e/download.spec.ts
git commit -m "feat(web): retain source bytes and ship a working Download

PdfService keeps a pristine copy of the opened file and exposes save().
With no edits yet this returns the original bytes untouched -- correct
for an unedited document, and the seam replay() plugs into at Task 24.

Also removes the disabled state and missing tooltip on the Download
button, the only control in TopBar without one."
```

---

## Task 23: The edit store — `EditDocument`, `applyOp`, and undo/redo

Pure state. No UI, no PDF, no worker. This is the single write path the entire phase depends on, so it gets the heaviest unit-test coverage in the plan.

**Files:**
- Create: `packages/pdf-core/src/write/types.ts`
- Create: `apps/web/src/stores/edits.ts`
- Modify: `apps/web/package.json` (add `immer`)
- Modify: `packages/pdf-core/src/index.ts` (export the types)
- Test: `apps/web/test/stores/edits.test.ts`

**Interfaces:**
- Consumes: `PageId` from `@/stores/document`; `Rect` from `@margin/transform`
- Produces:
  - `type EditDocument`, `type EditObject`, `type ObjectKind`, `type Op` from `@margin/pdf-core`
  - `useEditsStore()` exposing `doc` (computed), `selection` (computed), `canUndo`/`canRedo` (computed), and methods `applyOp`, `withTransaction`, `undo`, `redo`, `select`, `clearSelection`, `reset`

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @margin/web add immer
```

- [ ] **Step 2: Define the shared types**

Create `packages/pdf-core/src/write/types.ts`. These live in `pdf-core`, not `apps/web`, because both the store (main thread) and the writers (worker) need them and neither may depend on the other.

```ts
import type { Rect } from '@margin/transform'

export type ObjectId = string
export type PageId = string

export type ObjectKind =
  | 'text' | 'image' | 'rect' | 'ellipse' | 'line' | 'arrow'
  | 'ink' | 'highlight' | 'underline' | 'strikeout'
  | 'whiteout' | 'link' | 'signature'

/** sRGB, each channel 0..1 — the range MuPDF's colour setters take. */
export type Color = [number, number, number]

export type BaseObject = {
  id: ObjectId
  pageId: PageId
  kind: ObjectKind
  /** PDF user space, UNROTATED. Origin bottom-left. Never view pixels. */
  rect: Rect
  /** The object's own rotation in degrees, independent of the page's. */
  rotation: number
  z: number
  locked: boolean
  /** 0..1 */
  opacity: number
}

export type TextObject = BaseObject & {
  kind: 'text'
  text: string
  fontFamily: string
  fontSize: number
  color: Color
  align: 'left' | 'center' | 'right'
}

export type ImageObject = BaseObject & {
  kind: 'image'
  /** PNG or JPEG bytes, already decoded, downscaled, and EXIF-normalised. */
  data: Uint8Array
  mime: 'image/png' | 'image/jpeg'
}

export type ShapeObject = BaseObject & {
  kind: 'rect' | 'ellipse' | 'line' | 'arrow'
  stroke: Color | null
  strokeWidth: number
  fill: Color | null
}

export type WhiteoutObject = BaseObject & { kind: 'whiteout'; fill: Color }

export type InkObject = BaseObject & {
  kind: 'ink'
  /** One entry per stroke; each is a flat [x0,y0,x1,y1,...] in PDF space. */
  strokes: number[][]
  color: Color
  strokeWidth: number
}

export type MarkupObject = BaseObject & {
  kind: 'highlight' | 'underline' | 'strikeout'
  /**
   * 8 numbers per quad, in MuPDF PAGE space (top-down, CropBox-origin
   * normalised, /Rotate applied) -- NOT the raw bottom-up PDF space every
   * `rect` above uses. This is deliberate: buildQuadIndex (Task 36)
   * produces page space and setQuadPoints (Task 38) consumes it, so a
   * conversion in either direction would be a round trip through the wrong
   * space. `rect` on a MarkupObject still follows the usual rule and goes
   * through toAnnotSpace.
   */
  quads: number[][]
  color: Color
}

export type LinkObject = BaseObject & { kind: 'link'; uri: string }

export type SignatureObject = BaseObject & {
  kind: 'signature'
  data: Uint8Array
  mime: 'image/png'
}

export type EditObject =
  | TextObject | ImageObject | ShapeObject | WhiteoutObject
  | InkObject | MarkupObject | LinkObject | SignatureObject

export type EditDocument = {
  version: number
  /** SHA-256 of the original file. Guards replay against the wrong source. */
  sourceHash: string
  pageOrder: PageId[]
  pages: Record<PageId, { sourceIndex: number }>
  objects: Record<ObjectId, EditObject>
  nextZ: number
}

export type Op =
  | { type: 'addObject'; object: EditObject }
  | { type: 'updateObject'; id: ObjectId; patch: Partial<EditObject> }
  | { type: 'deleteObject'; id: ObjectId }
  | { type: 'reorder'; id: ObjectId; z: number }

export const EDIT_DOCUMENT_VERSION = 1
```

Export them from `packages/pdf-core/src/index.ts`:

```ts
export type {
  ObjectId, ObjectKind, Color, EditObject, EditDocument, Op,
  TextObject, ImageObject, ShapeObject, WhiteoutObject,
  InkObject, MarkupObject, LinkObject, SignatureObject,
} from './write/types.js'
export { EDIT_DOCUMENT_VERSION } from './write/types.js'
```

- [ ] **Step 3: Write the failing store tests**

Create `apps/web/test/stores/edits.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useEditsStore } from '@/stores/edits'
import type { EditObject } from '@margin/pdf-core'

function rectObject(id: string, pageId = 'p1'): EditObject {
  return {
    id, pageId, kind: 'rect',
    rect: { x: 10, y: 20, w: 100, h: 50 },
    rotation: 0, z: 1, locked: false, opacity: 1,
    stroke: [0, 0, 0], strokeWidth: 1, fill: null,
  }
}

describe('useEditsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useEditsStore().reset('hash-abc', ['p1', 'p2'], { p1: { sourceIndex: 0 }, p2: { sourceIndex: 1 } })
  })

  it('starts empty with the given source hash', () => {
    const s = useEditsStore()
    expect(s.doc.sourceHash).toBe('hash-abc')
    expect(Object.keys(s.doc.objects)).toHaveLength(0)
    expect(s.canUndo).toBe(false)
  })

  it('adds an object through applyOp', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    expect(s.doc.objects.o1?.kind).toBe('rect')
    expect(s.canUndo).toBe(true)
  })

  it('undo restores the exact prior state', () => {
    const s = useEditsStore()
    const before = structuredClone(s.doc)
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    s.undo()
    expect(s.doc).toEqual(before)
  })

  it('redo reapplies what undo removed', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    const after = structuredClone(s.doc)
    s.undo()
    s.redo()
    expect(s.doc).toEqual(after)
  })

  it('updateObject patches in place and inverts cleanly', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    s.applyOp({ type: 'updateObject', id: 'o1', patch: { opacity: 0.5 } }, 'Set opacity')
    expect(s.doc.objects.o1?.opacity).toBe(0.5)
    s.undo()
    expect(s.doc.objects.o1?.opacity).toBe(1)
  })

  it('deleteObject removes the object and undo brings it back intact', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    s.applyOp({ type: 'deleteObject', id: 'o1' }, 'Delete')
    expect(s.doc.objects.o1).toBeUndefined()
    s.undo()
    expect(s.doc.objects.o1).toEqual(rectObject('o1'))
  })

  it('a new op clears the redo stack', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    s.undo()
    expect(s.canRedo).toBe(true)
    s.applyOp({ type: 'addObject', object: rectObject('o2') }, 'Add rectangle')
    expect(s.canRedo).toBe(false)
  })

  it('withTransaction coalesces many ops into ONE history entry', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    s.withTransaction('Drag', () => {
      for (let x = 0; x < 60; x++) {
        s.applyOp({ type: 'updateObject', id: 'o1', patch: { rect: { x, y: 20, w: 100, h: 50 } } }, 'Drag')
      }
    })
    expect(s.doc.objects.o1?.rect.x).toBe(59)
    s.undo()
    // One undo must rewind the ENTIRE drag, not one of 60 frames.
    expect(s.doc.objects.o1?.rect.x).toBe(10)
  })

  it('nested transactions still produce one entry', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    s.withTransaction('Outer', () => {
      s.applyOp({ type: 'updateObject', id: 'o1', patch: { opacity: 0.5 } }, 'a')
      s.withTransaction('Inner', () => {
        s.applyOp({ type: 'updateObject', id: 'o1', patch: { opacity: 0.2 } }, 'b')
      })
    })
    s.undo()
    expect(s.doc.objects.o1?.opacity).toBe(1)
  })

  it('caps history and drops the oldest entries', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    for (let i = 0; i < 250; i++) {
      s.applyOp({ type: 'updateObject', id: 'o1', patch: { opacity: i / 250 } }, 'Opacity')
    }
    expect(s.historySize).toBeLessThanOrEqual(200)
    expect(s.canUndo).toBe(true)
  })

  it('assigns increasing z to each added object', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: { ...rectObject('o1'), z: s.nextZ() } }, 'a')
    s.applyOp({ type: 'addObject', object: { ...rectObject('o2'), z: s.nextZ() } }, 'b')
    expect(s.doc.objects.o2!.z).toBeGreaterThan(s.doc.objects.o1!.z)
  })

  it('undo on empty history is a no-op, not a throw', () => {
    const s = useEditsStore()
    expect(() => s.undo()).not.toThrow()
    expect(Object.keys(s.doc.objects)).toHaveLength(0)
  })

  // The single-write-path invariant (design §1.2). `doc` is exposed as a
  // computed, so this assignment is BOTH a compile error and a runtime
  // no-op. readonly() would give only the runtime half -- see the caveat
  // documented in stores/viewport.ts.
  it('exposes no writer other than applyOp', () => {
    const s = useEditsStore()
    const mutators = Object.keys(s).filter(
      (k) => typeof (s as Record<string, unknown>)[k] === 'function',
    )
    expect(mutators.sort()).toEqual(
      ['applyOp', 'clearSelection', 'nextZ', 'redo', 'reset', 'select', 'undo', 'withTransaction'].sort(),
    )
  })
})
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm vitest run --project web edits`
Expected: FAIL — cannot resolve `@/stores/edits`

- [ ] **Step 5: Implement the store**

Create `apps/web/src/stores/edits.ts`:

```ts
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { produceWithPatches, enablePatches, applyPatches, type Patch } from 'immer'
import { EDIT_DOCUMENT_VERSION, type EditDocument, type Op, type ObjectId } from '@margin/pdf-core'

// Immer ships patch support opt-in. Without this, produceWithPatches returns
// empty patch arrays and every undo silently does nothing.
enablePatches()

const HISTORY_LIMIT = 200
/**
 * Entry count alone is not a memory bound: an image or signature op carries
 * its pixel payload inside the patch. Cap accumulated patch weight too.
 */
const HISTORY_BYTES_LIMIT = 64 * 1024 * 1024

type HistoryEntry = {
  label: string
  patches: Patch[]
  inversePatches: Patch[]
  weight: number
}

function emptyDocument(): EditDocument {
  return {
    version: EDIT_DOCUMENT_VERSION,
    sourceHash: '',
    pageOrder: [],
    pages: {},
    objects: {},
    nextZ: 1,
  }
}

/**
 * Rough byte weight of a patch payload. Only typed arrays matter at this
 * scale (images, signatures); everything else is noise against a 64MB cap.
 */
function weigh(patches: Patch[]): number {
  let n = 0
  for (const p of patches) {
    const v = p.value as unknown
    if (v instanceof Uint8Array) n += v.byteLength
    else n += 64
  }
  return n
}

function reduce(draft: EditDocument, op: Op): void {
  switch (op.type) {
    case 'addObject':
      draft.objects[op.object.id] = op.object
      if (op.object.z >= draft.nextZ) draft.nextZ = op.object.z + 1
      break
    case 'updateObject': {
      const target = draft.objects[op.id]
      if (!target) return
      Object.assign(target, op.patch)
      break
    }
    case 'deleteObject':
      delete draft.objects[op.id]
      break
    case 'reorder': {
      const target = draft.objects[op.id]
      if (!target) return
      target.z = op.z
      if (op.z >= draft.nextZ) draft.nextZ = op.z + 1
      break
    }
  }
}

export const useEditsStore = defineStore('edits', () => {
  const state = ref<EditDocument>(emptyDocument())
  const past = ref<HistoryEntry[]>([])
  const future = ref<HistoryEntry[]>([])
  const selectedIds = ref<ObjectId[]>([])

  // Transaction depth, plus the patches accumulated across the whole
  // transaction. `applyOp` still mutates state immediately during a
  // transaction (the overlay must track the drag live) -- what the
  // transaction changes is HISTORY: 60 drag frames become one entry.
  let depth = 0
  let txPatches: Patch[] = []
  let txInverse: Patch[] = []
  let txLabel = ''

  function push(label: string, patches: Patch[], inversePatches: Patch[]): void {
    if (patches.length === 0) return
    past.value.push({ label, patches, inversePatches, weight: weigh(patches) })
    future.value = []
    let bytes = past.value.reduce((n, e) => n + e.weight, 0)
    while (past.value.length > HISTORY_LIMIT || (bytes > HISTORY_BYTES_LIMIT && past.value.length > 1)) {
      const dropped = past.value.shift()
      bytes -= dropped?.weight ?? 0
    }
  }

  function applyOp(op: Op, label: string): void {
    const [next, patches, inversePatches] = produceWithPatches(state.value, (draft) => {
      reduce(draft, op)
    })
    state.value = next as EditDocument
    if (depth > 0) {
      txPatches.push(...patches)
      // Inverses must be replayed in REVERSE order to unwind correctly, so
      // build the transaction's inverse list back-to-front as we go.
      txInverse.unshift(...inversePatches)
      return
    }
    push(label, patches, inversePatches)
  }

  /**
   * Coalesce every op emitted inside `fn` into a single history entry.
   * Required for drags, resizes, freehand strokes, and typing -- without it
   * one drag is 60 undo steps. Nested calls join the outermost transaction.
   */
  function withTransaction(label: string, fn: () => void): void {
    if (depth === 0) {
      txPatches = []
      txInverse = []
      txLabel = label
    }
    depth++
    try {
      fn()
    } finally {
      depth--
      if (depth === 0) {
        push(txLabel, txPatches, txInverse)
        txPatches = []
        txInverse = []
      }
    }
  }

  function undo(): void {
    const entry = past.value.pop()
    if (!entry) return
    state.value = applyPatches(state.value, entry.inversePatches)
    future.value.push(entry)
  }

  function redo(): void {
    const entry = future.value.pop()
    if (!entry) return
    state.value = applyPatches(state.value, entry.patches)
    past.value.push(entry)
  }

  function nextZ(): number {
    return state.value.nextZ
  }

  function select(ids: ObjectId[]): void { selectedIds.value = ids }
  function clearSelection(): void { selectedIds.value = [] }

  function reset(
    sourceHash: string,
    pageOrder: string[],
    pages: EditDocument['pages'],
  ): void {
    state.value = { ...emptyDocument(), sourceHash, pageOrder, pages }
    past.value = []
    future.value = []
    selectedIds.value = []
  }

  return {
    // computed(), NOT readonly(). Pinia's setup-store type extraction treats
    // any isRef()-true value as mutable state and only special-cases
    // computed() -- so readonly() would leave `edits.doc = x` type-clean
    // while silently failing at runtime. See stores/viewport.ts's caveat.
    doc: computed(() => state.value),
    selection: computed(() => selectedIds.value),
    canUndo: computed(() => past.value.length > 0),
    canRedo: computed(() => future.value.length > 0),
    historySize: computed(() => past.value.length),
    applyOp,
    withTransaction,
    undo,
    redo,
    nextZ,
    select,
    clearSelection,
    reset,
  }
})
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run --project web edits`
Expected: PASS — 14 tests

- [ ] **Step 7: Run the full suite and typecheck**

Run: `pnpm test && pnpm --filter @margin/web typecheck`
Expected: all pass

- [ ] **Step 8: Commit**

```bash
git add packages/pdf-core/src/write/types.ts packages/pdf-core/src/index.ts apps/web/src/stores/edits.ts apps/web/test/stores/edits.test.ts apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): edit store with applyOp and Immer inverse-patch history

Single write path per spec 1.2: components never assign to state, so
there is no second path that can desync history. Undo/redo comes from
produceWithPatches' inverse patches rather than a hand-written invert()
per op type, which is where these systems normally rot.

State is exposed as computed(), not readonly(): Pinia's setup-store type
extraction only special-cases computed(), so readonly() would leave a
direct assignment type-clean while failing silently at runtime -- the
trap already documented in stores/viewport.ts."
```

---
## Task 24: The write path — session, coordinates, and the pinning tests

**The most important task in this plan.** Phase 2's write path runs two coordinate conventions at once, and Phase 0 measured only one of them. This task builds the plumbing and then *proves*, with pixel assertions on rotated and offset-CropBox fixtures, that both conventions land where they claim to. Every object writer from Task 29 onward is built on what this task establishes; if a convention is wrong, it must be wrong here, on day one, in one file — not discovered after nine writers assume it.

**Files:**
- Create: `packages/pdf-core/src/write/session.ts`, `write/coords.ts`, `write/content.ts`, `write/index.ts`
- Modify: `packages/pdf-core/src/index.ts`
- Modify: `apps/web/src/workers/pdfService.ts` (route `save` through `replay`)
- Test: `packages/pdf-core/test/write/coords.test.ts`, `test/write/pinning.test.ts`, `test/write/replay.test.ts`

**Interfaces:**
- Consumes: `PdfDocument` and `renderPage` from `pdf-core`; `pdfRectToView` and `PageGeometry` from `@margin/transform`; `EditDocument` from `./types.js`
- Produces:
  - `withDocument<T>(bytes: Uint8Array, fn: (doc: PdfDocument, raw: mupdf.PDFDocument) => T): T`
  - `withPage<T>(raw: mupdf.PDFDocument, index: number, fn: (page: mupdf.PDFPage) => T): T`
  - `toAnnotSpace(rect: Rect, g: PageGeometry): [number, number, number, number]`
  - `toContentSpace(rect: Rect): Rect`
  - `appendContent(raw: mupdf.PDFDocument, page: mupdf.PDFPage, ops: string): void`
  - `replay(sourceBytes: Uint8Array, editDoc: EditDocument): Uint8Array`
  - `type ObjectWriter` and the `WRITERS` registry that Tasks 29-35 and 38 populate

- [ ] **Step 1: Write the failing coordinate unit tests**

Create `packages/pdf-core/test/write/coords.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { PageGeometry } from '@margin/transform'
import { toAnnotSpace, toContentSpace } from '../../src/write/coords.js'

const letter: PageGeometry = { cropBox: [0, 0, 612, 792], rotate: 0 }
const offset: PageGeometry = { cropBox: [20, 30, 632, 822], rotate: 0 }
const turned: PageGeometry = { cropBox: [0, 0, 612, 792], rotate: 90 }

describe('toContentSpace', () => {
  it('is the identity — content streams already use raw PDF user space', () => {
    const r = { x: 100, y: 200, w: 50, h: 30 }
    expect(toContentSpace(r)).toEqual(r)
  })
})

describe('toAnnotSpace', () => {
  it('flips y for an origin-zero page', () => {
    // PDF rect y=200..230 on a 792pt-tall page is page-space y=562..592.
    expect(toAnnotSpace({ x: 100, y: 200, w: 50, h: 30 }, letter))
      .toEqual([100, 562, 150, 592])
  })

  it('subtracts a non-zero CropBox origin', () => {
    // MuPDF normalises the CropBox origin to (0,0), so callers must not
    // re-add it. x: 100-20 = 80. y: 822-230 = 592 measured from the top.
    expect(toAnnotSpace({ x: 100, y: 200, w: 50, h: 30 }, offset))
      .toEqual([80, 592, 130, 622])
  })

  it('applies page rotation', () => {
    const [x0, y0, x1, y1] = toAnnotSpace({ x: 100, y: 200, w: 50, h: 30 }, turned)
    // A quarter-turned page swaps the displayed extent: 792 wide, 612 tall.
    expect(x1).toBeLessThanOrEqual(792)
    expect(y1).toBeLessThanOrEqual(612)
    expect(x1 - x0).toBeCloseTo(30, 6)
    expect(y1 - y0).toBeCloseTo(50, 6)
  })

  it('always returns x0<x1 and y0<y1', () => {
    for (const g of [letter, offset, turned]) {
      const [x0, y0, x1, y1] = toAnnotSpace({ x: 10, y: 10, w: 40, h: 20 }, g)
      expect(x1).toBeGreaterThan(x0)
      expect(y1).toBeGreaterThan(y0)
    }
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run --project pdf-core coords`
Expected: FAIL — cannot resolve `../../src/write/coords.js`

- [ ] **Step 3: Implement the coordinate module**

Create `packages/pdf-core/src/write/coords.ts`:

```ts
import { pdfRectToView, type PageGeometry, type Rect } from '@margin/transform'

/**
 * THE TWO CONVENTIONS. Read this before touching any object writer.
 *
 * Phase 2's write path speaks two different coordinate languages at once,
 * and mixing them produces output that looks correct on an unrotated,
 * origin-zero letter page and is wrong everywhere else. This module is the
 * only place either conversion happens.
 *
 * ---------------------------------------------------------------------
 * CONVENTION A -- annotation setters: PAGE SPACE AT SCALE 1
 * ---------------------------------------------------------------------
 * setRect / setQuadPoints / setLine / getRect are top-down, y=0 at the TOP
 * of the CropBox, with the CropBox origin already normalised to (0,0) and
 * /Rotate already applied. MuPDF's binding flips y transparently on every
 * get and set.
 *
 * This was MEASURED in Phase 0 (docs/findings/02-write-path.md Q2), two
 * independent ways: setRect([72,400,200,460]) read back identically while
 * the raw on-disk /Rect was [71,331,201,393]; and pixel-sampling a render
 * matched the unflipped formula within 1-3px while the naive PDF-spec flip
 * was off by 120-140px.
 *
 * Traps:
 *   - Pass points at SCALE 1, never zoom-scaled view pixels. A zoom-scaled
 *     rect is accepted silently and lands the annotation at a multiple of
 *     the correct offset.
 *   - Do NOT apply a manual bottom-up flip. MuPDF already did it.
 *   - Do NOT re-subtract the CropBox origin yourself; pdfRectToView handles
 *     it and MuPDF has already zeroed it (getBounds() === getBounds('CropBox'),
 *     docs/findings/01-read-path.md Q5).
 *
 * ---------------------------------------------------------------------
 * CONVENTION B -- content-stream operators: RAW PDF USER SPACE
 * ---------------------------------------------------------------------
 * Page content streams are drawn in unrotated PDF user space: origin
 * bottom-left, y-up, CropBox origin NOT normalised. Since every EditObject
 * already stores its rect in exactly that space, the conversion is the
 * identity -- and `toContentSpace` exists anyway, as a named seam, so that
 * writers call a documented conversion instead of silently assuming one.
 *
 * Phase 0 did NOT verify this end-to-end: it confirmed the Font/Text/Device
 * primitives render and measure correctly into a standalone Pixmap, but
 * explicitly noted that "wiring this into an actual page content-stream
 * edit was not tested". test/write/pinning.test.ts is what verifies it, and
 * it runs on every commit.
 */

/** Convention A. Returns a MuPDF Rect: [x0, y0, x1, y1], top-down page space. */
export function toAnnotSpace(rect: Rect, g: PageGeometry): [number, number, number, number] {
  // Scale 1 -- unscaled points, NOT zoom-scaled view pixels.
  const v = pdfRectToView(rect, g, 1)
  return [v.x, v.y, v.x + v.w, v.y + v.h]
}

/** Convention B. Identity by construction — see the module comment. */
export function toContentSpace(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
}

/** Formats a number for a content stream: no exponent notation, 4dp max. */
export function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project pdf-core coords`
Expected: PASS

- [ ] **Step 5: Implement the session lifecycle**

Create `packages/pdf-core/src/write/session.ts`:

```ts
import * as mupdf from 'mupdf'
import { PdfDocument } from '../engine.js'

/**
 * Open a document for writing and guarantee it is closed.
 *
 * Disposal is a CORRECTNESS requirement here, not hygiene: Phase 0 measured
 * that omitting .destroy() does not leak gradually but hard-crashes the WASM
 * heap with `malloc failed` inside a single few-hundred-page sweep
 * (docs/findings/00-engine-facts.md). Centralising the try/finally here is
 * why no object writer can forget it.
 */
export function withDocument<T>(
  bytes: Uint8Array,
  fn: (doc: PdfDocument, raw: mupdf.PDFDocument) => T,
): T {
  const doc = PdfDocument.open(bytes)
  try {
    return fn(doc, doc._raw())
  } finally {
    doc.close()
  }
}

/** Load one page and guarantee it is destroyed. Same reasoning as above. */
export function withPage<T>(
  raw: mupdf.PDFDocument,
  index: number,
  fn: (page: mupdf.PDFPage) => T,
): T {
  const page = raw.loadPage(index) as mupdf.PDFPage
  try {
    return fn(page)
  } finally {
    page.destroy()
  }
}

/**
 * 'compress' shrinks streams; 'garbage=compact' drops objects the edits
 * orphaned and renumbers the xref. Spec 2.1's export row names this exact
 * option string.
 */
export const SAVE_OPTIONS = 'compress,garbage=compact'
```

- [ ] **Step 6: Implement content-stream appending**

Create `packages/pdf-core/src/write/content.ts`:

```ts
import * as mupdf from 'mupdf'
import { num } from './coords.js'
import type { Color } from './types.js'

/**
 * Append a content-stream fragment to a page, without disturbing what is
 * already drawn there.
 *
 * /Contents may legally be either a single stream or an array of streams
 * that the viewer concatenates. Appending to the array form is the safe
 * edit: rewriting the existing stream would mean decoding, splicing, and
 * re-encoding content this application has no reason to touch. When the page
 * carries a single stream we promote it to a one-element array first.
 *
 * Every fragment is wrapped in q/Q so a writer that leaves the graphics
 * state dirty cannot corrupt whatever is appended after it.
 */
export function appendContent(
  raw: mupdf.PDFDocument,
  page: mupdf.PDFPage,
  ops: string,
): void {
  const stream = raw.addStream(`q\n${ops}\nQ\n`, {})
  const pageObj = page.getObject()
  const contents = pageObj.get('Contents')

  if (contents.isArray()) {
    contents.push(stream)
    return
  }

  const array = raw.newArray()
  if (!contents.isNull()) array.push(contents)
  array.push(stream)
  pageObj.put('Contents', array)
}

/**
 * Register a resource under /Resources/<category>/<name>, creating the
 * intermediate dictionaries when the page has none. Returns the name the
 * content stream should reference.
 *
 * Names are caller-supplied and must be unique per page; writers derive them
 * from the object id, which nanoid already guarantees is unique.
 */
export function addResource(
  raw: mupdf.PDFDocument,
  page: mupdf.PDFPage,
  category: 'XObject' | 'Font' | 'ExtGState',
  name: string,
  value: mupdf.PDFObject,
): string {
  const pageObj = page.getObject()
  let resources = pageObj.get('Resources')
  if (!resources.isDictionary()) {
    resources = raw.newDictionary()
    pageObj.put('Resources', resources)
  }
  let bucket = resources.get(category)
  if (!bucket.isDictionary()) {
    bucket = raw.newDictionary()
    resources.put(category, bucket)
  }
  bucket.put(name, value)
  return name
}

/** `0.2 0.4 1 rg` — non-stroking colour. */
export function fillColor(c: Color): string {
  return `${num(c[0])} ${num(c[1])} ${num(c[2])} rg`
}

/** `0.2 0.4 1 RG` — stroking colour. */
export function strokeColor(c: Color): string {
  return `${num(c[0])} ${num(c[1])} ${num(c[2])} RG`
}

/**
 * Constant alpha via an ExtGState. PDF has no inline opacity operator, so
 * transparency always costs a resource entry.
 */
export function alphaState(
  raw: mupdf.PDFDocument,
  page: mupdf.PDFPage,
  name: string,
  opacity: number,
): string {
  const gs = raw.newDictionary()
  gs.put('Type', raw.newName('ExtGState'))
  gs.put('ca', opacity)
  gs.put('CA', opacity)
  addResource(raw, page, 'ExtGState', name, raw.addObject(gs))
  return `/${name} gs`
}
```

- [ ] **Step 7: Write the pinning tests — the point of this task**

Create `packages/pdf-core/test/write/pinning.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { PdfDocument, renderPage } from '../../src/index.js'
import { pdfToView, type PageGeometry } from '@margin/transform'
import { withDocument, withPage, SAVE_OPTIONS } from '../../src/write/session.js'
import { appendContent, fillColor } from '../../src/write/content.js'
import { toAnnotSpace, toContentSpace, num } from '../../src/write/coords.js'

import { generateFixtures, fixturePath } from '../fixtures/index.js'

// Every pdf-core test bootstraps fixtures this way -- they are generated,
// not committed, so reading the path directly without this fails on a clean
// checkout. Matches test/golden.test.ts and test/render.test.ts.
beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: Parameters<typeof fixturePath>[0]): Uint8Array =>
  new Uint8Array(readFileSync(fixturePath(n)))

/** RGBA at a view-space point of a page rendered at scale 1. */
function samplePixel(pdf: Uint8Array, page: number, vx: number, vy: number) {
  const doc = PdfDocument.open(pdf)
  try {
    const { width, rgba } = renderPage(doc, page, 1)
    const i = (Math.round(vy) * width + Math.round(vx)) * 4
    return { r: rgba[i]!, g: rgba[i + 1]!, b: rgba[i + 2]! }
  } finally {
    doc.close()
  }
}

function geometryOf(pdf: Uint8Array, page: number): PageGeometry {
  const doc = PdfDocument.open(pdf)
  try {
    return doc.pageGeometry(page)
  } finally {
    doc.close()
  }
}

/** Draw an opaque red rect at `rect` (raw PDF space) and save. */
function drawRedRect(src: Uint8Array, page: number, rect: { x: number; y: number; w: number; h: number }): Uint8Array {
  return withDocument(src, (_doc, raw) =>
    withPage(raw, page, (p) => {
      const r = toContentSpace(rect)
      appendContent(raw, p, `${fillColor([1, 0, 0])} ${num(r.x)} ${num(r.y)} ${num(r.w)} ${num(r.h)} re f`)
      return raw.saveToBuffer(SAVE_OPTIONS).asUint8Array()
    }),
  )
}

// CONVENTION B. The claim under test: a content-stream `re` operator takes
// raw, unrotated, bottom-up PDF user space with the CropBox origin NOT
// normalised. If that is wrong, these three cases disagree with each other
// -- an origin-zero page alone would not catch it.
describe('Convention B — content-stream operators use raw PDF user space', () => {
  const cases: Array<[string, string, number]> = [
    ['origin-zero letter page', 'simple-text.pdf', 0],
    ['non-zero CropBox origin', 'offset-cropbox.pdf', 0],
    ['quarter-turned page', 'rotated.pdf', 1],
  ]

  for (const [label, fixture, pageIndex] of cases) {
    it(`lands where pdfToView predicts on a ${label}`, () => {
      const src = load(fixture)
      const g = geometryOf(src, pageIndex)
      // Place the rect inside the CropBox regardless of its origin.
      const rect = { x: g.cropBox[0] + 60, y: g.cropBox[1] + 60, w: 80, h: 40 }

      const out = drawRedRect(src, pageIndex, rect)

      // Centre of the rect, mapped through the SAME transform the on-screen
      // overlay uses. Preview and export agreeing is the whole point.
      const centre = pdfToView({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, g, 1)
      const px = samplePixel(out, pageIndex, centre.x, centre.y)

      expect(px.r).toBeGreaterThan(200)
      expect(px.g).toBeLessThan(60)
      expect(px.b).toBeLessThan(60)
    })
  }

  it('leaves the existing page content intact', () => {
    const src = bytes('simple-text')
    const g = geometryOf(src, 0)
    // Draw well away from the text, then confirm the text still renders by
    // comparing total ink against the untouched original.
    const out = drawRedRect(src, 0, { x: 20, y: 20, w: 30, h: 20 })
    const inkOf = (pdf: Uint8Array): number => {
      const doc = PdfDocument.open(pdf)
      try {
        const { rgba } = renderPage(doc, 0, 1)
        let n = 0
        for (let i = 0; i < rgba.length; i += 4) if (rgba[i]! < 200) n++
        return n
      } finally {
        doc.close()
      }
    }
    expect(inkOf(out)).toBeGreaterThan(inkOf(src))
  })
})

// CONVENTION A. Phase 0 measured this; the test exists so a MuPDF upgrade
// that changes the binding's y-flip behaviour fails loudly here rather than
// silently misplacing every highlight in the product.
describe('Convention A — annotation setters use page space at scale 1', () => {
  it('round-trips a rect through setRect/getRect unchanged', () => {
    const src = bytes('simple-text')
    const g = geometryOf(src, 0)
    const rect = { x: 100, y: 200, w: 50, h: 30 }
    const expected = toAnnotSpace(rect, g)

    const got = withDocument(src, (_doc, raw) =>
      withPage(raw, 0, (p) => {
        const annot = p.createAnnotation('Square')
        annot.setRect(expected)
        annot.update()
        return annot.getRect()
      }),
    )

    // MuPDF inflates by the border width on all four sides, so compare with
    // a tolerance rather than exactly -- Phase 0 observed 72->71, 200->201.
    for (let i = 0; i < 4; i++) expect(got[i]).toBeCloseTo(expected[i]!, 0)
  })

  it('places a Square annotation where pdfToView predicts, on a rotated page', () => {
    const src = bytes('rotated')
    const g = geometryOf(src, 1)
    const rect = { x: 80, y: 80, w: 120, h: 60 }

    const out = withDocument(src, (_doc, raw) =>
      withPage(raw, 1, (p) => {
        const annot = p.createAnnotation('Square')
        annot.setRect(toAnnotSpace(rect, g))
        annot.setInteriorColor([0, 1, 0])
        annot.setColor([0, 1, 0])
        annot.update()
        return raw.saveToBuffer(SAVE_OPTIONS).asUint8Array()
      }),
    )

    const centre = pdfToView({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, g, 1)
    const px = samplePixel(out, 1, centre.x, centre.y)
    expect(px.g).toBeGreaterThan(150)
    expect(px.r).toBeLessThan(120)
  })
})

// createLink's bbox space was never checked in Phase 0 -- getURI() round-
// tripped, but nothing verified where the hotspot landed. fz_link has no /AP
// and renders nothing, so this is asserted structurally rather than by pixel.
describe('createLink bbox space', () => {
  it('round-trips both the URI and a page-space bbox', () => {
    const src = bytes('simple-text')
    const g = geometryOf(src, 0)
    const rect = { x: 100, y: 200, w: 120, h: 24 }
    const expected = toAnnotSpace(rect, g)

    const links = withDocument(src, (_doc, raw) =>
      withPage(raw, 0, (p) => {
        p.createLink(expected, 'https://example.com/a')
        const saved = raw.saveToBuffer(SAVE_OPTIONS).asUint8Array()
        return saved
      }),
    )

    const reopened = PdfDocument.open(links)
    try {
      const page = reopened._raw().loadPage(0)
      try {
        const found = page.getLinks()
        expect(found).toHaveLength(1)
        expect(found[0]!.getURI()).toBe('https://example.com/a')
        const bounds = found[0]!.getBounds()
        for (let i = 0; i < 4; i++) expect(bounds[i]).toBeCloseTo(expected[i]!, 0)
      } finally {
        page.destroy()
      }
    } finally {
      reopened.close()
    }
  })
})
```

- [ ] **Step 8: Run the pinning tests**

Run: `pnpm vitest run --project pdf-core pinning`

Expected: PASS.

**If Convention B fails**, do not adjust the test to match the observed output — that would bake the bug in. Sample the render to find where the rect actually landed, work out which transform explains it, and fix `toContentSpace` in `write/coords.ts`. It is the only place that needs to change, which is the entire reason this task comes before any object writer. Record what you found in `docs/findings/` — Phase 0's findings are the reference for later phases and this would amend them.

- [ ] **Step 9: Write the failing replay test**

Create `packages/pdf-core/test/write/replay.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { replay } from '../../src/write/index.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument } from '../../src/write/types.js'
import { PdfDocument } from '../../src/index.js'
import { assertGolden } from '../golden.js'

import { generateFixtures, fixturePath } from '../fixtures/index.js'

// Every pdf-core test bootstraps fixtures this way -- they are generated,
// not committed, so reading the path directly without this fails on a clean
// checkout. Matches test/golden.test.ts and test/render.test.ts.
beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: Parameters<typeof fixturePath>[0]): Uint8Array =>
  new Uint8Array(readFileSync(fixturePath(n)))

function emptyEdits(pageCount: number): EditDocument {
  const pageOrder = Array.from({ length: pageCount }, (_, i) => `p${i}`)
  const pages = Object.fromEntries(pageOrder.map((id, i) => [id, { sourceIndex: i }]))
  return {
    version: EDIT_DOCUMENT_VERSION,
    sourceHash: '',
    pageOrder,
    pages,
    objects: {},
    nextZ: 1,
  }
}

describe('replay', () => {
  it('produces a document that still opens and keeps its page count', () => {
    const src = bytes('multi-page')
    // multi-page.pdf is 12 pages -- pinned by the existing
    // apps/web/test/workers/pdfService.test.ts, which asserts the same count.
    const out = replay(src, emptyEdits(12))
    const doc = PdfDocument.open(out)
    try {
      expect(doc.pageCount).toBe(12)
    } finally {
      doc.close()
    }
  })

  it('renders identically to the source when there are no objects', async () => {
    const src = bytes('simple-text')
    // Reuses the Phase 0 golden rig: same committed baseline the read path
    // is already checked against, so a write-path regression that alters
    // untouched pages fails here.
    await assertGolden('simple-text-p0', replay(src, emptyEdits(1)))
  })

  it('rejects an EditDocument written by a newer schema version', () => {
    const src = bytes('simple-text')
    const edits = { ...emptyEdits(1), version: EDIT_DOCUMENT_VERSION + 1 }
    expect(() => replay(src, edits)).toThrow(/version/i)
  })

  it('throws rather than silently skipping an unknown object kind', () => {
    const src = bytes('simple-text')
    const edits = emptyEdits(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    edits.objects.x1 = { id: 'x1', pageId: 'p0', kind: 'nope' } as any
    expect(() => replay(src, edits)).toThrow(/nope/)
  })
})
```

- [ ] **Step 10: Run it to verify it fails**

Run: `pnpm vitest run --project pdf-core replay`
Expected: FAIL — cannot resolve `../../src/write/index.js`

- [ ] **Step 11: Implement `replay`**

Create `packages/pdf-core/src/write/index.ts`:

```ts
import * as mupdf from 'mupdf'
import { withDocument, withPage, SAVE_OPTIONS } from './session.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument, type EditObject, type ObjectKind } from './types.js'
import type { PageGeometry } from '@margin/transform'

export type WriteContext = {
  raw: mupdf.PDFDocument
  page: mupdf.PDFPage
  geometry: PageGeometry
}

export type ObjectWriter = (ctx: WriteContext, object: EditObject) => void

/**
 * One writer per ObjectKind. Tasks 29-35 and 38 each register their kind
 * here; this map is deliberately the ONLY place a kind becomes a drawing
 * operation, so an unhandled kind is a loud startup-time gap rather than a
 * silently-dropped object in someone's exported document.
 */
export const WRITERS: Partial<Record<ObjectKind, ObjectWriter>> = {}

/**
 * Build the exported document.
 *
 * A pure function of its inputs: it opens a SECOND document from the
 * pristine source bytes and never touches the one being rendered, which is
 * what keeps spec 1.5's deferred-bake invariant true. Runs entirely in the
 * worker, and is fully testable in Node with no browser.
 */
export function replay(sourceBytes: Uint8Array, editDoc: EditDocument): Uint8Array {
  if (editDoc.version > EDIT_DOCUMENT_VERSION) {
    throw new Error(
      `This document was edited by a newer version of get-margin ` +
        `(schema version ${editDoc.version}, this build understands ${EDIT_DOCUMENT_VERSION}).`,
    )
  }

  return withDocument(sourceBytes, (doc, raw) => {
    // Group objects by page once, then draw each page's objects in z order.
    // Sorting per page rather than globally keeps stacking well-defined
    // within a page without imposing a meaningless order across pages.
    const byPage = new Map<string, EditObject[]>()
    for (const object of Object.values(editDoc.objects)) {
      const list = byPage.get(object.pageId)
      if (list) list.push(object)
      else byPage.set(object.pageId, [object])
    }

    for (const pageId of editDoc.pageOrder) {
      const objects = byPage.get(pageId)
      if (!objects || objects.length === 0) continue

      const sourceIndex = editDoc.pages[pageId]?.sourceIndex
      if (sourceIndex === undefined) {
        throw new Error(`edit document references unknown page "${pageId}"`)
      }

      objects.sort((a, b) => a.z - b.z)
      const geometry = doc.pageGeometry(sourceIndex)

      withPage(raw, sourceIndex, (page) => {
        for (const object of objects) {
          const writer = WRITERS[object.kind]
          if (!writer) {
            // Fail the WHOLE export. A partial PDF that silently dropped a
            // signature is worse than a failed download, because the user
            // will not notice the omission.
            throw new Error(
              `no writer registered for object kind "${object.kind}" (object ${object.id})`,
            )
          }
          writer({ raw, page, geometry }, object)
        }
      })
    }

    return raw.saveToBuffer(SAVE_OPTIONS).asUint8Array()
  })
}

export { withDocument, withPage, SAVE_OPTIONS } from './session.js'
export { toAnnotSpace, toContentSpace, num } from './coords.js'
export { appendContent, addResource, fillColor, strokeColor, alphaState } from './content.js'
```

Add to `packages/pdf-core/src/index.ts`:

```ts
export { replay, WRITERS, type ObjectWriter, type WriteContext } from './write/index.js'
```

- [ ] **Step 12: Run the replay tests**

Run: `pnpm vitest run --project pdf-core replay`
Expected: PASS

- [ ] **Step 13: Route `PdfService.save` through `replay`**

In `apps/web/src/workers/pdfService.ts`, import `replay` and change `save`:

```ts
import { PdfDocument, renderPage, replay, type EditDocument } from '@margin/pdf-core'

  /**
   * The exported document.
   *
   * With no edits, returns the user's original bytes untouched rather than a
   * MuPDF re-serialisation -- an unedited download should hand back exactly
   * what was opened, not a normalised file with a different size.
   */
  save(editDoc?: EditDocument): Uint8Array {
    const src = this.#sourceBytes
    if (!src) throw new Error('no document open')
    if (!editDoc || Object.keys(editDoc.objects).length === 0) return src
    return replay(src, editDoc)
  }
```

Update `PdfClient.save` in `pdfClient.ts` to `save(editDoc?: EditDocument): Promise<Uint8Array>` and forward the argument. Update `TopBar.vue`'s `download()` to pass `edits.doc`:

```ts
const bytes = await getPdfClient().save(edits.doc)
```

with `const edits = useEditsStore()` added to the script block.

- [ ] **Step 14: Extend the service test**

Append to `apps/web/test/workers/pdfService.test.ts`:

```ts
it('still returns the original bytes when the edit document is empty', () => {
  const svc = new PdfService()
  const src = bytes('simple-text')
  svc.open(src.slice())
  const empty = {
    version: 1, sourceHash: '', pageOrder: ['p0'],
    pages: { p0: { sourceIndex: 0 } }, objects: {}, nextZ: 1,
  }
  expect(Array.from(svc.save(empty))).toEqual(Array.from(src))
})
```

- [ ] **Step 15: Run everything**

Run: `pnpm test && pnpm typecheck && pnpm --filter @margin/web typecheck`
Expected: all pass

- [ ] **Step 16: Commit**

```bash
git add packages/pdf-core/src/write packages/pdf-core/src/index.ts packages/pdf-core/test/write apps/web/src/workers apps/web/src/app/TopBar.vue apps/web/test
git commit -m "feat(pdf-core): write-path spine with pinned coordinate conventions

replay(sourceBytes, editDoc) is a pure function: it opens a second
document from the pristine source and never touches the one being
rendered, keeping spec 1.5's deferred-bake invariant true.

write/coords.ts owns both conventions the write path speaks -- page
space at scale 1 for annotation setters, raw bottom-up PDF space for
content-stream operators -- and test/write/pinning.test.ts proves both
with pixel assertions on rotated and offset-CropBox fixtures, not just
on an origin-zero letter page where a wrong transform still looks right.

Phase 0 verified content-stream drawing only into a standalone Pixmap
and never checked createLink's bbox space; both are now pinned and run
on every commit."
```

---
## Task 25: The SVG overlay

Layer 2 of spec §1.3 — the load-bearing trick of the design. Because the viewBox is the page's PDF dimensions and all three of MuPDF's baked-in transforms sit on one root `<g>`, every object renders at its raw stored coordinates with zero per-object maths, and zoom is nothing but a CSS width change.

**Both strings this needs already exist and are already property-tested** across random rects × 4 rotations × zoom levels × non-zero CropBox origins: `svgViewBox(g)` and `svgRootTransform(g)` in `@margin/transform`. This task consumes them. It must not compute coordinates itself.

**Files:**
- Create: `apps/web/src/features/overlay/PageOverlay.vue`, `features/overlay/ObjectLayer.vue`
- Create: `apps/web/src/features/overlay/objects/RectObject.vue`
- Modify: `apps/web/src/features/viewport/PageList.vue` (mount the overlay)
- Modify: `apps/web/src/stores/document.ts` (seed the edit store on open)
- Test: `apps/web/test/features/PageOverlay.test.ts`

**Interfaces:**
- Consumes: `useEditsStore()` from Task 23; `svgViewBox`/`svgRootTransform` from `@margin/transform`; `PageState` from `@/stores/document`
- Produces: `PageOverlay` with props `{ page: PageState; zoom: number }`

- [ ] **Step 1: Write the failing overlay test**

Create `apps/web/test/features/PageOverlay.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import PageOverlay from '@/features/overlay/PageOverlay.vue'
import { useEditsStore } from '@/stores/edits'
import type { PageState } from '@/stores/document'
import type { EditObject } from '@margin/pdf-core'

const page: PageState = {
  id: 'p1',
  sourceIndex: 0,
  geometry: { cropBox: [0, 0, 612, 792], rotate: 0 },
}

const turned: PageState = {
  id: 'p2',
  sourceIndex: 1,
  geometry: { cropBox: [0, 0, 612, 792], rotate: 90 },
}

function obj(id: string, pageId: string, z = 1): EditObject {
  return {
    id, pageId, kind: 'rect',
    rect: { x: 10, y: 20, w: 100, h: 50 },
    rotation: 0, z, locked: false, opacity: 1,
    stroke: [0, 0, 0], strokeWidth: 1, fill: null,
  }
}

describe('PageOverlay', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useEditsStore().reset('h', ['p1', 'p2'], { p1: { sourceIndex: 0 }, p2: { sourceIndex: 1 } })
  })

  it('sets the viewBox to the page dimensions in points', () => {
    const w = mount(PageOverlay, { props: { page, zoom: 1 } })
    expect(w.find('svg').attributes('viewBox')).toBe('0 0 612 792')
  })

  it('swaps the viewBox extent on a quarter-turned page', () => {
    const w = mount(PageOverlay, { props: { page: turned, zoom: 1 } })
    expect(w.find('svg').attributes('viewBox')).toBe('0 0 792 612')
  })

  it('keeps the viewBox constant across zoom — zoom is a CSS concern only', () => {
    const a = mount(PageOverlay, { props: { page, zoom: 1 } })
    const b = mount(PageOverlay, { props: { page, zoom: 3.5 } })
    expect(b.find('svg').attributes('viewBox')).toBe(a.find('svg').attributes('viewBox'))
  })

  it('puts the page transform on a single root group', () => {
    const w = mount(PageOverlay, { props: { page, zoom: 1 } })
    const groups = w.findAll('svg > g')
    expect(groups).toHaveLength(1)
    expect(groups[0]!.attributes('transform')).toContain('scale(1 -1)')
  })

  it('renders only the objects belonging to this page', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: obj('a', 'p1') }, 'add')
    s.applyOp({ type: 'addObject', object: obj('b', 'p2') }, 'add')
    const w = mount(PageOverlay, { props: { page, zoom: 1 } })
    expect(w.findAll('[data-object-id]')).toHaveLength(1)
    expect(w.find('[data-object-id]').attributes('data-object-id')).toBe('a')
  })

  it('renders objects in ascending z order', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: obj('high', 'p1', 9) }, 'add')
    s.applyOp({ type: 'addObject', object: obj('low', 'p1', 1) }, 'add')
    const ids = mount(PageOverlay, { props: { page, zoom: 1 } })
      .findAll('[data-object-id]')
      .map((n) => n.attributes('data-object-id'))
    expect(ids).toEqual(['low', 'high'])
  })

  it('is pointer-transparent where there is no object', () => {
    const w = mount(PageOverlay, { props: { page, zoom: 1 } })
    expect(w.find('svg').classes()).toContain('pointer-events-none')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project web PageOverlay`
Expected: FAIL — cannot resolve `@/features/overlay/PageOverlay.vue`

- [ ] **Step 3: Implement the overlay**

Create `apps/web/src/features/overlay/PageOverlay.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { svgViewBox, svgRootTransform } from '@margin/transform'
import type { PageState } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import ObjectLayer from './ObjectLayer.vue'

const props = defineProps<{ page: PageState; zoom: number }>()
const edits = useEditsStore()

/**
 * Spec 1.3, Layer 2. The viewBox is the page's DISPLAYED extent in points
 * and the root <g> carries all three of MuPDF's baked-in page-space
 * transforms (CropBox origin to (0,0), y-flip, /Rotate). Both strings come
 * from @margin/transform, which is property-tested against MuPDF's own
 * getTransform() matrices -- this component must never compute either
 * itself. Consequence: objects below render at raw stored PDF coordinates
 * with no per-object maths, and zoom never touches this markup.
 */
const viewBox = computed(() => svgViewBox(props.page.geometry))
const rootTransform = computed(() => svgRootTransform(props.page.geometry))

const objects = computed(() =>
  Object.values(edits.doc.objects)
    .filter((o) => o.pageId === props.page.id)
    .sort((a, b) => a.z - b.z),
)
</script>

<template>
  <!--
    pointer-events-none on the <svg> with pointer-events-auto per object
    (see ObjectLayer): the overlay covers the whole page, so a
    pointer-transparent default is what keeps text selection, scrolling, and
    the page canvas beneath it reachable. Individual objects opt back in.

    No width/height attributes: the element is stretched by `inset-0
    size-full` to exactly the canvas box PageCanvas established from the
    same geometry, so the two can never disagree about size.
  -->
  <svg
    class="pointer-events-none absolute inset-0 size-full"
    :viewBox="viewBox"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <g :transform="rootTransform">
      <ObjectLayer v-for="o in objects" :key="o.id" :object="o" />
    </g>
  </svg>
</template>
```

Create `apps/web/src/features/overlay/ObjectLayer.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import type { EditObject } from '@margin/pdf-core'
import RectObject from './objects/RectObject.vue'

const props = defineProps<{ object: EditObject }>()

/**
 * Kind -> component. Tasks 29-35 register their own here. An unregistered
 * kind renders nothing rather than throwing: a half-broken overlay is
 * recoverable, and the EXPORT path is where an unknown kind must fail loudly
 * (see WRITERS in pdf-core/src/write/index.ts).
 */
const COMPONENTS = { rect: RectObject } as const

const component = computed(() => COMPONENTS[props.object.kind as keyof typeof COMPONENTS])

/**
 * Object-local rotation about its own centre. Page rotation is NOT applied
 * here -- it is already on the overlay's root <g>.
 */
const transform = computed(() => {
  const { rect, rotation } = props.object
  if (!rotation) return undefined
  return `rotate(${rotation} ${rect.x + rect.w / 2} ${rect.y + rect.h / 2})`
})
</script>

<template>
  <g
    v-if="component"
    :data-object-id="props.object.id"
    :transform="transform"
    :opacity="props.object.opacity"
    class="pointer-events-auto"
  >
    <component :is="component" :object="props.object" />
  </g>
</template>
```

Create `apps/web/src/features/overlay/objects/RectObject.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import type { ShapeObject } from '@margin/pdf-core'

const props = defineProps<{ object: ShapeObject }>()

/** `[0.2,0.4,1]` (MuPDF's 0..1 range) -> `rgb(51,102,255)` for CSS/SVG. */
const rgb = (c: [number, number, number] | null): string =>
  c ? `rgb(${c.map((n) => Math.round(n * 255)).join(',')})` : 'none'

const fill = computed(() => rgb(props.object.fill))
const stroke = computed(() => rgb(props.object.stroke))
</script>

<template>
  <!--
    y is the object's PDF-space BOTTOM edge; the root <g>'s y-flip means an
    SVG <rect> drawn at that y with positive height extends upward on screen,
    exactly as PDF space intends. No manual flip here -- that is the point
    of putting the transform on the root group.
  -->
  <rect
    :x="props.object.rect.x"
    :y="props.object.rect.y"
    :width="props.object.rect.w"
    :height="props.object.rect.h"
    :fill="fill"
    :stroke="stroke"
    :stroke-width="props.object.strokeWidth"
    vector-effect="non-scaling-stroke"
  />
</template>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project web PageOverlay`
Expected: PASS — 7 tests

- [ ] **Step 5: Seed the edit store when a document opens**

In `apps/web/src/stores/document.ts`, import the edit store and reset it inside `_applyInfo`, so page ids are shared by construction rather than by a second derivation:

```ts
import { useEditsStore } from '@/stores/edits'

    _applyInfo(info: { pageCount: number; geometries: PageGeometry[] }): void {
      const order: PageId[] = []
      const pages: Record<PageId, PageState> = {}
      for (let i = 0; i < info.pageCount; i++) {
        const geometry = info.geometries[i]
        if (!geometry) throw new Error(`missing geometry for page ${i}`)
        const id = nanoid(10)
        order.push(id)
        pages[id] = { id, sourceIndex: i, geometry }
      }
      this.pageOrder = order
      this.pages = pages

      // Objects reference a synthetic pageId, never a page index (spec
      // 1.2b) -- so the edit store must be seeded with THESE ids, from the
      // one place they are minted. Deriving them a second time elsewhere is
      // how objects end up orphaned or attributed to the wrong page.
      useEditsStore().reset(
        this.sourceHash,
        order,
        Object.fromEntries(order.map((id, i) => [id, { sourceIndex: i }])),
      )
    },
```

Add to `apps/web/test/stores/document.test.ts`:

```ts
it('seeds the edit store with the same page ids it minted', async () => {
  const doc = useDocumentStore()
  const edits = useEditsStore()
  await doc.openFile(pdfFile())
  expect(edits.doc.pageOrder).toEqual(doc.pageOrder)
  expect(edits.doc.sourceHash).toBe(doc.sourceHash)
})
```

- [ ] **Step 6: Mount the overlay in the page list**

In `apps/web/src/features/viewport/PageList.vue`, wrap the canvas so the overlay shares its box:

```vue
<div class="relative">
  <PageCanvas
    v-if="doc.pages[doc.pageOrder[item.index]!]"
    :page="doc.pages[doc.pageOrder[item.index]!]!"
    :zoom="vp.zoom"
    :bitmap="vp.bitmapFor(doc.pageOrder[item.index]!)"
  />
  <!--
    Spec 1.3: only pages within +/-1 of the anchor mount an overlay. Pages
    outside that window keep their bitmap and drop their objects from the
    DOM, which is what keeps a 300-page annotated document responsive.
    `overscan: 2` on the virtualizer means `items` is already wider than
    this window, so the guard is a real filter, not a no-op.
  -->
  <PageOverlay
    v-if="doc.pages[doc.pageOrder[item.index]!] && Math.abs(item.index - vp.anchorIndex) <= 1"
    :page="doc.pages[doc.pageOrder[item.index]!]!"
    :zoom="vp.zoom"
  />
</div>
```

and import it: `import PageOverlay from '@/features/overlay/PageOverlay.vue'`.

- [ ] **Step 7: Run the full suite, typecheck, and build**

Run: `pnpm test && pnpm --filter @margin/web typecheck && pnpm --filter @margin/web build`
Expected: all pass

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/overlay apps/web/src/features/viewport/PageList.vue apps/web/src/stores/document.ts apps/web/test
git commit -m "feat(web): SVG object overlay per visible page

Spec 1.3 Layer 2. viewBox is the page's displayed extent in points and
all three of MuPDF's baked-in page-space transforms sit on one root <g>,
both strings taken from @margin/transform's already-property-tested
svgViewBox/svgRootTransform. Objects therefore render at raw stored PDF
coordinates with no per-object maths, and zoom is a CSS width change
that never touches this markup.

document.ts seeds the edit store from the same place page ids are
minted, so objects can never reference an id derived a second way."
```

---

## Task 26: Selection and transform handles

Layer 3 — DOM chrome, deliberately not SVG, so Tailwind, focus management, and mobile keyboards behave normally. Snapping is **out of scope** (deferred to Phase 4 per the design); this task delivers drag, resize, and rotate.

**Files:**
- Create: `apps/web/src/features/overlay/SelectionChrome.vue`
- Create: `apps/web/src/features/overlay/useDragGesture.ts`
- Modify: `apps/web/src/features/overlay/PageOverlay.vue` (hit-testing, emit selection)
- Test: `apps/web/test/features/SelectionChrome.test.ts`, `apps/web/test/features/useDragGesture.test.ts`

**Interfaces:**
- Consumes: `useEditsStore()` — specifically `applyOp`, `withTransaction`, `select`, `selection`
- Produces: `SelectionChrome` with props `{ page: PageState; zoom: number }`; `useDragGesture(opts)` returning `{ onPointerDown }`

- [ ] **Step 1: Write the failing gesture test**

Create `apps/web/test/features/useDragGesture.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { useDragGesture } from '@/features/overlay/useDragGesture'

function pointer(type: string, x: number, y: number): PointerEvent {
  const e = new Event(type, { bubbles: true }) as PointerEvent
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1 })
  return e
}

describe('useDragGesture', () => {
  it('reports deltas relative to the pointer-down position', () => {
    const moves: Array<{ dx: number; dy: number }> = []
    const { onPointerDown } = useDragGesture({
      onMove: (d) => moves.push(d),
      onEnd: () => {},
    })
    const el = document.createElement('div')
    el.setPointerCapture = vi.fn()
    el.releasePointerCapture = vi.fn()
    onPointerDown(Object.assign(pointer('pointerdown', 100, 100), { currentTarget: el }))
    window.dispatchEvent(pointer('pointermove', 130, 90))
    expect(moves).toEqual([{ dx: 30, dy: -10 }])
  })

  it('calls onEnd exactly once and stops listening after pointerup', () => {
    const onEnd = vi.fn()
    const onMove = vi.fn()
    const { onPointerDown } = useDragGesture({ onMove, onEnd })
    const el = document.createElement('div')
    el.setPointerCapture = vi.fn()
    el.releasePointerCapture = vi.fn()
    onPointerDown(Object.assign(pointer('pointerdown', 0, 0), { currentTarget: el }))
    window.dispatchEvent(pointer('pointerup', 10, 10))
    window.dispatchEvent(pointer('pointermove', 50, 50))
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('ends the gesture on pointercancel too', () => {
    const onEnd = vi.fn()
    const { onPointerDown } = useDragGesture({ onMove: () => {}, onEnd })
    const el = document.createElement('div')
    el.setPointerCapture = vi.fn()
    el.releasePointerCapture = vi.fn()
    onPointerDown(Object.assign(pointer('pointerdown', 0, 0), { currentTarget: el }))
    window.dispatchEvent(pointer('pointercancel', 0, 0))
    expect(onEnd).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project web useDragGesture`
Expected: FAIL — cannot resolve the module

- [ ] **Step 3: Implement the gesture composable**

Create `apps/web/src/features/overlay/useDragGesture.ts`:

```ts
export type DragDelta = { dx: number; dy: number }

export type DragOptions = {
  onMove: (delta: DragDelta) => void
  onEnd: () => void
}

/**
 * A pointer drag reported as deltas in CSS pixels.
 *
 * Listeners go on `window`, not the element: a fast drag outruns the
 * element under the cursor, and a pointerup delivered outside it would
 * otherwise leave the gesture running forever. Pointer capture is requested
 * as well so the browser keeps routing events to the origin element where
 * it is supported.
 *
 * Deltas are CSS pixels; the CALLER converts to PDF space via
 * @margin/transform. This module performs no coordinate maths.
 */
export function useDragGesture(opts: DragOptions) {
  function onPointerDown(e: PointerEvent): void {
    const target = e.currentTarget as Element | null
    const startX = e.clientX
    const startY = e.clientY
    try {
      target?.setPointerCapture?.(e.pointerId)
    } catch {
      // Pointer capture is best-effort; window listeners are the guarantee.
    }

    const move = (ev: Event): void => {
      const p = ev as PointerEvent
      opts.onMove({ dx: p.clientX - startX, dy: p.clientY - startY })
    }

    const end = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      try {
        target?.releasePointerCapture?.(e.pointerId)
      } catch {
        // Already released, or never captured.
      }
      opts.onEnd()
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  return { onPointerDown }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run --project web useDragGesture`
Expected: PASS

- [ ] **Step 5: Write the failing selection-chrome test**

Create `apps/web/test/features/SelectionChrome.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SelectionChrome from '@/features/overlay/SelectionChrome.vue'
import { useEditsStore } from '@/stores/edits'
import type { PageState } from '@/stores/document'
import type { EditObject } from '@margin/pdf-core'

const page: PageState = { id: 'p1', sourceIndex: 0, geometry: { cropBox: [0, 0, 612, 792], rotate: 0 } }

const object: EditObject = {
  id: 'o1', pageId: 'p1', kind: 'rect',
  rect: { x: 100, y: 200, w: 80, h: 40 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  stroke: [0, 0, 0], strokeWidth: 1, fill: null,
}

describe('SelectionChrome', () => {
  let edits: ReturnType<typeof useEditsStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    edits.reset('h', ['p1'], { p1: { sourceIndex: 0 } })
    edits.applyOp({ type: 'addObject', object }, 'add')
  })

  it('renders nothing when there is no selection', () => {
    const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
    expect(w.find('[data-selection]').exists()).toBe(false)
  })

  it('renders eight resize handles plus a rotate handle when selected', () => {
    edits.select(['o1'])
    const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
    expect(w.findAll('[data-handle]')).toHaveLength(8)
    expect(w.find('[data-rotate-handle]').exists()).toBe(true)
  })

  it('positions the box in view space, accounting for the y-flip', () => {
    edits.select(['o1'])
    const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
    const box = w.find('[data-selection]').element as HTMLElement
    // PDF y=200..240 on a 792pt page -> view top = 792-240 = 552.
    expect(box.style.left).toBe('100px')
    expect(box.style.top).toBe('552px')
    expect(box.style.width).toBe('80px')
    expect(box.style.height).toBe('40px')
  })

  it('scales the box with zoom', () => {
    edits.select(['o1'])
    const w = mount(SelectionChrome, { props: { page, zoom: 2 } })
    const box = w.find('[data-selection]').element as HTMLElement
    expect(box.style.left).toBe('200px')
    expect(box.style.width).toBe('160px')
  })

  it('shows no handles on a locked object', () => {
    edits.applyOp({ type: 'updateObject', id: 'o1', patch: { locked: true } }, 'lock')
    edits.select(['o1'])
    const w = mount(SelectionChrome, { props: { page, zoom: 1 } })
    expect(w.findAll('[data-handle]')).toHaveLength(0)
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm vitest run --project web SelectionChrome`
Expected: FAIL — cannot resolve the component

- [ ] **Step 7: Implement the selection chrome**

Create `apps/web/src/features/overlay/SelectionChrome.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { pdfRectToView, viewRectToPdf } from '@margin/transform'
import type { PageState } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useDragGesture } from './useDragGesture'

const props = defineProps<{ page: PageState; zoom: number }>()
const edits = useEditsStore()

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
type Handle = (typeof HANDLES)[number]

const selected = computed(() => {
  const id = edits.selection[0]
  const o = id ? edits.doc.objects[id] : undefined
  return o && o.pageId === props.page.id ? o : undefined
})

/**
 * The selection box in view space. All conversion goes through
 * @margin/transform -- this component performs no coordinate arithmetic of
 * its own (spec 1.4's standing rule).
 */
const box = computed(() => {
  const o = selected.value
  return o ? pdfRectToView(o.rect, props.page.geometry, props.zoom) : undefined
})

const style = computed(() => {
  const b = box.value
  if (!b) return {}
  return { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` }
})

/** Resize anchors: which view-space edges a handle moves. */
const EDGES: Record<Handle, { l: number; t: number; r: number; b: number }> = {
  nw: { l: 1, t: 1, r: 0, b: 0 }, n: { l: 0, t: 1, r: 0, b: 0 },
  ne: { l: 0, t: 1, r: 1, b: 0 }, e: { l: 0, t: 0, r: 1, b: 0 },
  se: { l: 0, t: 0, r: 1, b: 1 }, s: { l: 0, t: 0, r: 0, b: 1 },
  sw: { l: 1, t: 0, r: 0, b: 1 }, w: { l: 1, t: 0, r: 0, b: 0 },
}

const MIN_SIZE_PT = 4

function commit(viewRect: { x: number; y: number; w: number; h: number }): void {
  const o = selected.value
  if (!o) return
  const rect = viewRectToPdf(viewRect, props.page.geometry, props.zoom)
  edits.applyOp({ type: 'updateObject', id: o.id, patch: { rect } }, 'Move')
}

/**
 * One transaction per gesture. Without this a single drag is 60 undo steps
 * -- the exact failure withTransaction exists to prevent (spec 1.2).
 * applyOp still fires on every frame so the overlay tracks the pointer
 * live; only HISTORY is coalesced.
 */
function startMove(e: PointerEvent): void {
  const o = selected.value
  const start = box.value
  if (!o || !start || o.locked) return
  let ended = false
  edits.withTransaction('Move', () => {
    const { onPointerDown } = useDragGesture({
      onMove: ({ dx, dy }) => commit({ ...start, x: start.x + dx, y: start.y + dy }),
      onEnd: () => { ended = true },
    })
    onPointerDown(e)
  })
  void ended
}

function startResize(e: PointerEvent, handle: Handle): void {
  const o = selected.value
  const start = box.value
  if (!o || !start || o.locked) return
  const edge = EDGES[handle]
  edits.withTransaction('Resize', () => {
    const { onPointerDown } = useDragGesture({
      onMove: ({ dx, dy }) => {
        const x = start.x + edge.l * dx
        const y = start.y + edge.t * dy
        const w = Math.max(MIN_SIZE_PT * props.zoom, start.w + edge.r * dx - edge.l * dx)
        const h = Math.max(MIN_SIZE_PT * props.zoom, start.h + edge.b * dy - edge.t * dy)
        commit({ x, y, w, h })
      },
      onEnd: () => {},
    })
    onPointerDown(e)
  })
}

function startRotate(e: PointerEvent): void {
  const o = selected.value
  const start = box.value
  if (!o || !start || o.locked) return
  const cx = start.x + start.w / 2
  const cy = start.y + start.h / 2
  const base = o.rotation
  edits.withTransaction('Rotate', () => {
    const { onPointerDown } = useDragGesture({
      onMove: ({ dx, dy }) => {
        // Angle from the box centre to the current pointer, in degrees.
        const deg = (Math.atan2(cy + dy - cy, cx + dx - cx) * 180) / Math.PI
        edits.applyOp(
          { type: 'updateObject', id: o.id, patch: { rotation: Math.round(base + deg) } },
          'Rotate',
        )
      },
      onEnd: () => {},
    })
    onPointerDown(e)
  })
}
</script>

<template>
  <!--
    Layer 3: DOM, not SVG, deliberately (spec 1.3). Tailwind classes, focus
    management, and mobile virtual keyboards all behave normally here and do
    not inside an <svg>.
  -->
  <div
    v-if="selected && box"
    data-selection
    class="pointer-events-auto absolute cursor-move ring-2 ring-accent"
    :style="style"
    @pointerdown.stop="startMove"
  >
    <template v-if="!selected.locked">
      <button
        v-for="h in HANDLES"
        :key="h"
        :data-handle="h"
        type="button"
        :aria-label="`Resize ${h}`"
        class="absolute size-2.5 rounded-full border border-accent bg-surface"
        :class="{
          'left-0 -translate-x-1/2': h.includes('w'),
          'right-0 translate-x-1/2': h.includes('e'),
          'left-1/2 -translate-x-1/2': h === 'n' || h === 's',
          'top-0 -translate-y-1/2': h.includes('n'),
          'bottom-0 translate-y-1/2': h.includes('s'),
          'top-1/2 -translate-y-1/2': h === 'e' || h === 'w',
        }"
        @pointerdown.stop="(e) => startResize(e, h)"
      />
      <button
        data-rotate-handle
        type="button"
        aria-label="Rotate"
        class="absolute -top-6 left-1/2 size-2.5 -translate-x-1/2 rounded-full border border-accent bg-surface"
        @pointerdown.stop="startRotate"
      />
    </template>
  </div>
</template>
```

- [ ] **Step 8: Wire hit-testing into the overlay**

In `PageOverlay.vue`, add a click handler on each object group and mount the chrome as a sibling of the `<svg>`. Because `ObjectLayer`'s `<g>` is `pointer-events-auto` inside a `pointer-events-none` `<svg>`, only the objects themselves are clickable:

```vue
<ObjectLayer
  v-for="o in objects"
  :key="o.id"
  :object="o"
  @pointerdown="edits.select([o.id])"
/>
```

and after the `</svg>`:

```vue
<SelectionChrome :page="props.page" :zoom="props.zoom" />
```

Wrap both in a `<div class="pointer-events-none absolute inset-0">` so the chrome positions against the same box.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm vitest run --project web SelectionChrome PageOverlay`
Expected: PASS

- [ ] **Step 10: Run everything and commit**

Run: `pnpm test && pnpm --filter @margin/web typecheck`

```bash
git add apps/web/src/features/overlay apps/web/test/features
git commit -m "feat(web): selection box, resize handles, and rotation

Layer 3 is DOM rather than SVG (spec 1.3) so Tailwind, focus, and
mobile keyboards behave normally. Every gesture runs inside one
withTransaction, so a drag is one undo step rather than sixty.

useDragGesture listens on window rather than the element: a fast drag
outruns the element under the cursor and a pointerup delivered outside
it would otherwise leave the gesture running forever.

Snapping and alignment guides are deliberately absent -- deferred to
Phase 4 per PHASE-2-DESIGN.md section 0."
```

---
## Task 27: Tool rail, tool strip, and the tools store

Fills the two slots Phase 1 left as comments: `DesktopShell.vue:35` ("Phase 2 inserts the 64px tool rail here") and `MobileShell.vue:50`.

**Files:**
- Create: `apps/web/src/stores/tools.ts`, `features/tools/ToolRail.vue`, `features/tools/ToolStrip.vue`
- Modify: `apps/web/src/app/layouts/DesktopShell.vue:35`, `apps/web/src/app/layouts/MobileShell.vue:50`
- Test: `apps/web/test/stores/tools.test.ts`, `apps/web/test/features/ToolRail.test.ts`

**Interfaces:**
- Produces: `useToolsStore()` exposing `active` (computed), `draft` (computed), `setTool`, `setDraft`, `clearDraft`; `type ToolId = 'select' | 'text' | 'image' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'ink' | 'whiteout' | 'link' | 'signature' | 'highlight' | 'underline' | 'strikeout'`

- [ ] **Step 1: Write the failing tools-store test**

Create `apps/web/test/stores/tools.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useToolsStore } from '@/stores/tools'
import { useEditsStore } from '@/stores/edits'

describe('useToolsStore', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('starts on the select tool', () => {
    expect(useToolsStore().active).toBe('select')
  })

  it('switches tools', () => {
    const t = useToolsStore()
    t.setTool('rect')
    expect(t.active).toBe('rect')
  })

  it('clears the selection when leaving the select tool', () => {
    const t = useToolsStore()
    const e = useEditsStore()
    e.reset('h', ['p1'], { p1: { sourceIndex: 0 } })
    e.select(['o1'])
    t.setTool('rect')
    expect(e.selection).toEqual([])
  })

  it('drops any in-flight draft when the tool changes', () => {
    const t = useToolsStore()
    t.setTool('rect')
    t.setDraft({ pageId: 'p1', rect: { x: 0, y: 0, w: 10, h: 10 } })
    t.setTool('ellipse')
    expect(t.draft).toBeUndefined()
  })

  it('never records tool state in edit history', () => {
    const t = useToolsStore()
    const e = useEditsStore()
    e.reset('h', ['p1'], { p1: { sourceIndex: 0 } })
    t.setTool('rect')
    t.setDraft({ pageId: 'p1', rect: { x: 0, y: 0, w: 10, h: 10 } })
    expect(e.canUndo).toBe(false)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (`pnpm vitest run --project web tools`)

- [ ] **Step 3: Implement the tools store**

Create `apps/web/src/stores/tools.ts`:

```ts
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Rect } from '@margin/transform'
import { useEditsStore } from '@/stores/edits'

export type ToolId =
  | 'select' | 'text' | 'image' | 'rect' | 'ellipse' | 'line' | 'arrow'
  | 'ink' | 'whiteout' | 'link' | 'signature'
  | 'highlight' | 'underline' | 'strikeout'

/** An object being dragged out but not yet committed. */
export type Draft = { pageId: string; rect: Rect }

/**
 * Transient tool state. NOTHING here enters edit history -- a half-drawn
 * rectangle is not an undoable step. The moment a draft becomes real it goes
 * through edits.applyOp and this store forgets it.
 */
export const useToolsStore = defineStore('tools', () => {
  const active = ref<ToolId>('select')
  const draft = ref<Draft | undefined>(undefined)

  function setTool(id: ToolId): void {
    if (id === active.value) return
    active.value = id
    draft.value = undefined
    // A selection belongs to the select tool. Leaving it visible while a
    // drawing tool is active makes the handles look interactive when they
    // are not.
    if (id !== 'select') useEditsStore().clearSelection()
  }

  function setDraft(d: Draft): void { draft.value = d }
  function clearDraft(): void { draft.value = undefined }

  return {
    active: computed(() => active.value),
    draft: computed(() => draft.value),
    setTool,
    setDraft,
    clearDraft,
  }
})
```

- [ ] **Step 4: Run it — expect PASS**

- [ ] **Step 5: Write the failing rail test**

Create `apps/web/test/features/ToolRail.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import ToolRail from '@/features/tools/ToolRail.vue'
import { useToolsStore } from '@/stores/tools'

describe('ToolRail', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('gives every tool button an accessible name', () => {
    const w = mount(ToolRail)
    const buttons = w.findAll('button')
    expect(buttons.length).toBeGreaterThan(5)
    for (const b of buttons) expect(b.attributes('aria-label')).toBeTruthy()
  })

  it('marks the active tool with aria-pressed', () => {
    const w = mount(ToolRail)
    const rect = w.get('[aria-label="Rectangle"]')
    expect(rect.attributes('aria-pressed')).toBe('false')
    useToolsStore().setTool('rect')
    expect(w.get('[aria-label="Rectangle"]').attributes('aria-pressed')).toBe('true')
  })

  it('activates a tool on click', async () => {
    const w = mount(ToolRail)
    await w.get('[aria-label="Whiteout"]').trigger('click')
    expect(useToolsStore().active).toBe('whiteout')
  })

  it('names the whiteout tool honestly — never "redact"', () => {
    const html = mount(ToolRail).html().toLowerCase()
    expect(html).toContain('whiteout')
    expect(html).not.toContain('redact')
  })
})
```

- [ ] **Step 6: Run it — expect FAIL**

- [ ] **Step 7: Implement the rail and strip**

Create `apps/web/src/features/tools/ToolRail.vue`:

```vue
<script setup lang="ts">
import {
  MousePointer2, Type, Image, Square, Circle, Minus, ArrowRight,
  Pen, Eraser, Link2, Signature, Highlighter, Underline, Strikethrough,
} from 'lucide-vue-next'
import IconButton from '@/ui/IconButton.vue'
import Tooltip from '@/ui/Tooltip.vue'
import { useToolsStore, type ToolId } from '@/stores/tools'

const tools = useToolsStore()

/**
 * `label` is both the tooltip and the accessible name. "Whiteout" is
 * deliberate and load-bearing: the tool COVERS content and does not remove
 * it (spec 2.1). Calling it "redact" would be a user-harm risk -- people
 * white out SSNs and believe they are gone. Real redaction is Phase 6.
 */
const TOOLS: Array<{ id: ToolId; label: string; icon: unknown }> = [
  { id: 'select', label: 'Select', icon: MousePointer2 },
  { id: 'text', label: 'Text', icon: Type },
  { id: 'image', label: 'Image', icon: Image },
  { id: 'rect', label: 'Rectangle', icon: Square },
  { id: 'ellipse', label: 'Ellipse', icon: Circle },
  { id: 'line', label: 'Line', icon: Minus },
  { id: 'arrow', label: 'Arrow', icon: ArrowRight },
  { id: 'ink', label: 'Draw', icon: Pen },
  { id: 'whiteout', label: 'Whiteout', icon: Eraser },
  { id: 'link', label: 'Link', icon: Link2 },
  { id: 'signature', label: 'Signature', icon: Signature },
  { id: 'highlight', label: 'Highlight', icon: Highlighter },
  { id: 'underline', label: 'Underline', icon: Underline },
  { id: 'strikeout', label: 'Strikeout', icon: Strikethrough },
]
</script>

<template>
  <nav
    class="flex w-16 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border bg-surface py-2"
    aria-label="Tools"
  >
    <Tooltip v-for="t in TOOLS" :key="t.id" :content="t.label" side="right">
      <IconButton
        size="sm"
        :label="t.label"
        :active="tools.active === t.id"
        :aria-pressed="tools.active === t.id"
        @click="tools.setTool(t.id)"
      >
        <component :is="t.icon" :size="18" :stroke-width="1.5" />
      </IconButton>
    </Tooltip>
  </nav>
</template>
```

Create `apps/web/src/features/tools/ToolStrip.vue` with the same `TOOLS` array imported from a shared `apps/web/src/features/tools/toolList.ts` (extract it there so the two shells cannot drift apart), laid out horizontally:

```vue
<template>
  <nav
    class="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border bg-surface px-2 py-1.5"
    aria-label="Tools"
  >
    <IconButton
      v-for="t in TOOLS" :key="t.id" size="sm" :label="t.label"
      :active="tools.active === t.id" :aria-pressed="tools.active === t.id"
      @click="tools.setTool(t.id)"
    >
      <component :is="t.icon" :size="18" :stroke-width="1.5" />
    </IconButton>
  </nav>
</template>
```

Mount `ToolRail` at `DesktopShell.vue:35` and `ToolStrip` at `MobileShell.vue:50`, replacing the placeholder comments.

- [ ] **Step 8: Run tests, typecheck, build, commit**

Run: `pnpm test && pnpm --filter @margin/web typecheck && pnpm --filter @margin/web build`

```bash
git add apps/web/src/stores/tools.ts apps/web/src/features/tools apps/web/src/app/layouts apps/web/test
git commit -m "feat(web): tool rail, tool strip, and transient tool state

Fills the two slots Phase 1 left as comments. Tool state never enters
edit history -- a half-drawn rectangle is not an undoable step.

The whiteout tool is named 'Whiteout', with a test asserting the word
'redact' appears nowhere: it covers content and does not remove it, and
conflating the two is a real user-harm risk (spec 2.1)."
```

---

## Task 28: Inspector, bottom sheet, and the floating selection toolbar

**Files:**
- Create: `apps/web/src/features/tools/Inspector.vue`, `InspectorSheet.vue`, `SelectionToolbar.vue`
- Create: `apps/web/src/features/tools/inspectorFields.ts`
- Modify: `DesktopShell.vue:63`, `MobileShell.vue`
- Test: `apps/web/test/features/Inspector.test.ts`

**Interfaces:**
- Consumes: `useEditsStore()`, `useToolsStore()`
- Produces: `Inspector` (no props — reads the stores); `fieldsFor(kind: ObjectKind): Field[]` from `inspectorFields.ts`

- [ ] **Step 1: Write the failing inspector test**

Create `apps/web/test/features/Inspector.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import Inspector from '@/features/tools/Inspector.vue'
import { useEditsStore } from '@/stores/edits'
import type { EditObject } from '@margin/pdf-core'

const rect: EditObject = {
  id: 'o1', pageId: 'p1', kind: 'rect',
  rect: { x: 10, y: 20, w: 100, h: 50 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  stroke: [0, 0, 0], strokeWidth: 2, fill: null,
}

describe('Inspector', () => {
  let edits: ReturnType<typeof useEditsStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    edits.reset('h', ['p1'], { p1: { sourceIndex: 0 } })
    edits.applyOp({ type: 'addObject', object: rect }, 'add')
  })

  it('prompts to select something when nothing is selected', () => {
    expect(mount(Inspector).text()).toContain('Select an object')
  })

  it('shows the fields for the selected kind', () => {
    edits.select(['o1'])
    const w = mount(Inspector)
    expect(w.find('[data-field="strokeWidth"]').exists()).toBe(true)
    expect(w.find('[data-field="opacity"]').exists()).toBe(true)
    expect(w.find('[data-field="fontSize"]').exists()).toBe(false)
  })

  it('writes changes through applyOp, so they are undoable', async () => {
    edits.select(['o1'])
    const w = mount(Inspector)
    await w.get('[data-field="opacity"] input').setValue('0.5')
    expect(edits.doc.objects.o1?.opacity).toBe(0.5)
    edits.undo()
    expect(edits.doc.objects.o1?.opacity).toBe(1)
  })

  it('coalesces a slider drag into one history entry', async () => {
    edits.select(['o1'])
    const w = mount(Inspector)
    const input = w.get('[data-field="opacity"] input')
    const before = edits.historySize
    for (const v of ['0.9', '0.8', '0.7', '0.6']) await input.setValue(v)
    await input.trigger('change')
    expect(edits.historySize).toBe(before + 1)
  })

  it('disables every field on a locked object', async () => {
    edits.applyOp({ type: 'updateObject', id: 'o1', patch: { locked: true } }, 'lock')
    edits.select(['o1'])
    const w = mount(Inspector)
    for (const i of w.findAll('input')) expect(i.attributes('disabled')).toBeDefined()
  })
})
```

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement the field registry**

Create `apps/web/src/features/tools/inspectorFields.ts`:

```ts
import type { ObjectKind } from '@margin/pdf-core'

export type Field =
  | { key: string; label: string; type: 'number'; min: number; max: number; step: number }
  | { key: string; label: string; type: 'color' }
  | { key: string; label: string; type: 'text' }
  | { key: string; label: string; type: 'select'; options: Array<{ value: string; label: string }> }

const OPACITY: Field = { key: 'opacity', label: 'Opacity', type: 'number', min: 0, max: 1, step: 0.05 }
const ROTATION: Field = { key: 'rotation', label: 'Rotation', type: 'number', min: -180, max: 180, step: 1 }

const SHAPE: Field[] = [
  { key: 'stroke', label: 'Stroke', type: 'color' },
  { key: 'strokeWidth', label: 'Stroke width', type: 'number', min: 0, max: 24, step: 0.5 },
  { key: 'fill', label: 'Fill', type: 'color' },
  OPACITY, ROTATION,
]

const TEXT: Field[] = [
  { key: 'fontFamily', label: 'Font', type: 'select', options: [] },
  { key: 'fontSize', label: 'Size', type: 'number', min: 4, max: 144, step: 1 },
  { key: 'color', label: 'Colour', type: 'color' },
  {
    key: 'align', label: 'Align', type: 'select',
    options: [
      { value: 'left', label: 'Left' },
      { value: 'center', label: 'Centre' },
      { value: 'right', label: 'Right' },
    ],
  },
  OPACITY, ROTATION,
]

/**
 * Kind -> editable fields. Adding a field here is all a tool task needs to
 * do to make it editable; the Inspector renders whatever this returns, so no
 * tool ships its own bespoke panel.
 */
const REGISTRY: Partial<Record<ObjectKind, Field[]>> = {
  rect: SHAPE, ellipse: SHAPE, line: SHAPE, arrow: SHAPE,
  text: TEXT,
  whiteout: [{ key: 'fill', label: 'Colour', type: 'color' }, OPACITY],
  ink: [
    { key: 'color', label: 'Colour', type: 'color' },
    { key: 'strokeWidth', label: 'Thickness', type: 'number', min: 0.5, max: 24, step: 0.5 },
    OPACITY,
  ],
  highlight: [{ key: 'color', label: 'Colour', type: 'color' }, OPACITY],
  underline: [{ key: 'color', label: 'Colour', type: 'color' }, OPACITY],
  strikeout: [{ key: 'color', label: 'Colour', type: 'color' }, OPACITY],
  link: [{ key: 'uri', label: 'URL', type: 'text' }],
  image: [OPACITY, ROTATION],
  signature: [OPACITY, ROTATION],
}

export function fieldsFor(kind: ObjectKind): Field[] {
  return REGISTRY[kind] ?? []
}
```

- [ ] **Step 4: Implement the Inspector**

Create `apps/web/src/features/tools/Inspector.vue`. Key behaviours: read the single selected object, render `fieldsFor(kind)`, write every change through `edits.applyOp`, and coalesce continuous edits with `withTransaction` opened on first `input` and closed on `change`/blur:

```vue
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useEditsStore } from '@/stores/edits'
import { fieldsFor } from './inspectorFields'

const edits = useEditsStore()
const selected = computed(() => {
  const id = edits.selection[0]
  return id ? edits.doc.objects[id] : undefined
})
const fields = computed(() => (selected.value ? fieldsFor(selected.value.kind) : []))

// A slider emits an `input` per pixel of travel. Opening a transaction on
// the first one and closing it on `change` turns a drag into one undo step,
// the same discipline SelectionChrome uses for pointer drags.
const dragging = ref(false)
let end: (() => void) | undefined

function write(key: string, value: unknown): void {
  const o = selected.value
  if (!o || o.locked) return
  edits.applyOp({ type: 'updateObject', id: o.id, patch: { [key]: value } as never }, 'Edit')
}

function onInput(key: string, value: unknown): void {
  if (!dragging.value) {
    dragging.value = true
    edits.withTransaction('Edit', () => {
      write(key, value)
      end = () => {}
    })
    return
  }
  write(key, value)
}

function onCommit(): void {
  dragging.value = false
  end = undefined
}
</script>
```

> **Implementation note for the executor:** `withTransaction` takes a synchronous callback, so a transaction cannot straddle two separate DOM events as written above. Implement this instead by buffering: on the first `input`, snapshot the object; on `change`, run one `withTransaction` that replays the final value. The test "coalesces a slider drag into one history entry" is what pins the behaviour — make it pass rather than matching this sketch literally.

Render the template with `data-field="<key>"` on each row, `:disabled="selected.locked"` on every control, and an empty state reading "Select an object to edit its properties."

- [ ] **Step 5: Implement `InspectorSheet.vue` and `SelectionToolbar.vue`**

`InspectorSheet.vue` wraps the same `Inspector` body in a `reka-ui` bottom sheet for mobile — it must import `Inspector.vue` rather than duplicating field rendering. `SelectionToolbar.vue` is an absolutely-positioned row above the selection box with Duplicate, Delete, Bring to front, Send to back, and Lock, each issuing one `applyOp`.

- [ ] **Step 6: Mount them**

`Inspector` at `DesktopShell.vue:63`; `InspectorSheet` in `MobileShell.vue`; `SelectionToolbar` inside `PageOverlay.vue` next to `SelectionChrome`.

- [ ] **Step 7: Run everything and commit**

```bash
git add apps/web/src/features/tools apps/web/src/app/layouts apps/web/test
git commit -m "feat(web): inspector panel, mobile sheet, and selection toolbar

One field registry drives every kind's panel, so a tool task makes a
property editable by adding a row rather than shipping a bespoke panel.
Continuous edits coalesce into one history entry, matching the drag
discipline in SelectionChrome."
```

---

## Task 29: Shapes — rect, ellipse, line, arrow

The first tool, and the template every later tool follows: **overlay renderer · inspector fields · object writer · golden test**.

**Files:**
- Create: `apps/web/src/features/overlay/objects/EllipseObject.vue`, `LineObject.vue`, `ArrowObject.vue`
- Create: `apps/web/src/features/overlay/useDrawTool.ts`
- Create: `packages/pdf-core/src/write/objects/shape.ts`
- Modify: `ObjectLayer.vue` (register components), `write/index.ts` (register writers)
- Test: `apps/web/test/features/drawShapes.test.ts`, `packages/pdf-core/test/write/shape.test.ts`

**Interfaces:**
- Consumes: `appendContent`, `fillColor`, `strokeColor`, `alphaState`, `toContentSpace`, `num` from the write path; `useToolsStore`, `useEditsStore`
- Produces: `writeShape: ObjectWriter` registered for `rect`, `ellipse`, `line`, `arrow`; `useDrawTool(page, zoom)` returning `{ onPointerDown }`

- [ ] **Step 1: Write the failing writer test**

Create `packages/pdf-core/test/write/shape.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { replay } from '../../src/write/index.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument, type EditObject } from '../../src/write/types.js'
import { PdfDocument, renderPage } from '../../src/index.js'
import { pdfToView } from '@margin/transform'
import { assertGolden } from '../golden.js'

import { generateFixtures, fixturePath } from '../fixtures/index.js'

// Every pdf-core test bootstraps fixtures this way -- they are generated,
// not committed, so reading the path directly without this fails on a clean
// checkout. Matches test/golden.test.ts and test/render.test.ts.
beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: Parameters<typeof fixturePath>[0]): Uint8Array =>
  new Uint8Array(readFileSync(fixturePath(n)))

function docWith(objects: EditObject[]): EditDocument {
  return {
    version: EDIT_DOCUMENT_VERSION, sourceHash: '',
    pageOrder: ['p0'], pages: { p0: { sourceIndex: 0 } },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])), nextZ: 99,
  }
}

const base = {
  pageId: 'p0', rotation: 0, z: 1, locked: false, opacity: 1,
  stroke: [0, 0, 1] as [number, number, number], strokeWidth: 2, fill: null,
}

function sample(pdf: Uint8Array, x: number, y: number) {
  const doc = PdfDocument.open(pdf)
  try {
    const { width, rgba } = renderPage(doc, 0, 1)
    const i = (Math.round(y) * width + Math.round(x)) * 4
    return { r: rgba[i]!, g: rgba[i + 1]!, b: rgba[i + 2]! }
  } finally { doc.close() }
}

describe('shape writer', () => {
  const src = bytes('simple-text')
  const geom = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }

  it('fills a rect at the stored PDF coordinates', () => {
    const out = replay(src, docWith([{
      ...base, id: 'r1', kind: 'rect',
      rect: { x: 100, y: 300, w: 120, h: 80 },
      fill: [1, 0, 0], stroke: null,
    } as EditObject]))
    const c = pdfToView({ x: 160, y: 340 }, geom, 1)
    const px = sample(out, c.x, c.y)
    expect(px.r).toBeGreaterThan(200)
    expect(px.g).toBeLessThan(60)
  })

  it('leaves the interior of an unfilled rect untouched', () => {
    const out = replay(src, docWith([{
      ...base, id: 'r1', kind: 'rect',
      rect: { x: 100, y: 300, w: 120, h: 80 }, fill: null,
    } as EditObject]))
    const c = pdfToView({ x: 160, y: 340 }, geom, 1)
    const px = sample(out, c.x, c.y)
    expect(px.r).toBeGreaterThan(200)
    expect(px.g).toBeGreaterThan(200)
    expect(px.b).toBeGreaterThan(200)
  })

  it('honours opacity via an ExtGState', () => {
    const out = replay(src, docWith([{
      ...base, id: 'r1', kind: 'rect', opacity: 0.5,
      rect: { x: 100, y: 300, w: 120, h: 80 }, fill: [1, 0, 0], stroke: null,
    } as EditObject]))
    const c = pdfToView({ x: 160, y: 340 }, geom, 1)
    const px = sample(out, c.x, c.y)
    // Half-opacity red over white: red stays high, green/blue land mid-range
    // rather than near zero.
    expect(px.g).toBeGreaterThan(90)
    expect(px.g).toBeLessThan(200)
  })

  it('draws all four kinds without throwing', () => {
    const kinds = ['rect', 'ellipse', 'line', 'arrow'] as const
    const out = replay(src, docWith(kinds.map((kind, i) => ({
      ...base, id: `s${i}`, kind,
      rect: { x: 60 + i * 60, y: 500, w: 50, h: 40 },
    } as EditObject))))
    expect(out.byteLength).toBeGreaterThan(0)
  })

  it('matches the reviewed golden', async () => {
    const out = replay(src, docWith([
      { ...base, id: 'a', kind: 'rect', rect: { x: 60, y: 600, w: 120, h: 60 }, fill: [1, 0.9, 0.2] } as EditObject,
      { ...base, id: 'b', kind: 'ellipse', rect: { x: 220, y: 600, w: 120, h: 60 } } as EditObject,
      { ...base, id: 'c', kind: 'line', rect: { x: 60, y: 540, w: 280, h: 0 } } as EditObject,
      { ...base, id: 'd', kind: 'arrow', rect: { x: 60, y: 480, w: 280, h: 0 } } as EditObject,
    ]))
    await assertGolden('export-shapes', out)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (`no writer registered for object kind "rect"`)

- [ ] **Step 3: Implement the shape writer**

Create `packages/pdf-core/src/write/objects/shape.ts`:

```ts
import type { ObjectWriter } from '../index.js'
import type { ShapeObject } from '../types.js'
import { appendContent, fillColor, strokeColor, alphaState } from '../content.js'
import { toContentSpace, num } from '../coords.js'

/** Bezier constant for approximating a quarter circle with a cubic. */
const K = 0.5522847498

const ARROWHEAD_LEN = 12
const ARROWHEAD_HALF_WIDTH = 5

function ellipsePath(x: number, y: number, w: number, h: number): string {
  const rx = w / 2
  const ry = h / 2
  const cx = x + rx
  const cy = y + ry
  const ox = rx * K
  const oy = ry * K
  return [
    `${num(cx - rx)} ${num(cy)} m`,
    `${num(cx - rx)} ${num(cy + oy)} ${num(cx - ox)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c`,
    `${num(cx + ox)} ${num(cy + ry)} ${num(cx + rx)} ${num(cy + oy)} ${num(cx + rx)} ${num(cy)} c`,
    `${num(cx + rx)} ${num(cy - oy)} ${num(cx + ox)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c`,
    `${num(cx - ox)} ${num(cy - ry)} ${num(cx - rx)} ${num(cy - oy)} ${num(cx - rx)} ${num(cy)} c`,
  ].join('\n')
}

/**
 * The arrowhead is computed geometry -- a filled triangle at the line's end,
 * not an annotation feature (spec 2.1). Drawn in the same content stream so
 * it can never separate from its shaft.
 */
function arrowPath(x: number, y: number, w: number, h: number): string {
  const x2 = x + w
  const y2 = y + h
  const len = Math.hypot(w, h) || 1
  const ux = w / len
  const uy = h / len
  const bx = x2 - ux * ARROWHEAD_LEN
  const by = y2 - uy * ARROWHEAD_LEN
  // Perpendicular unit vector.
  const px = -uy * ARROWHEAD_HALF_WIDTH
  const py = ux * ARROWHEAD_HALF_WIDTH
  return [
    `${num(x)} ${num(y)} m ${num(bx)} ${num(by)} l S`,
    `${num(x2)} ${num(y2)} m ${num(bx + px)} ${num(by + py)} l ${num(bx - px)} ${num(by - py)} l h f`,
  ].join('\n')
}

export const writeShape: ObjectWriter = (ctx, object) => {
  const o = object as ShapeObject
  const { x, y, w, h } = toContentSpace(o.rect)
  const ops: string[] = []

  if (o.opacity < 1) ops.push(alphaState(ctx.raw, ctx.page, `gs${o.id}`, o.opacity))
  if (o.fill) ops.push(fillColor(o.fill))
  if (o.stroke) {
    ops.push(strokeColor(o.stroke))
    ops.push(`${num(o.strokeWidth)} w`)
  }

  // Painting operator: fill only, stroke only, or both. A shape with
  // neither draws nothing rather than defaulting to a stroke the user did
  // not ask for.
  const paint = o.fill && o.stroke ? 'B' : o.fill ? 'f' : o.stroke ? 'S' : 'n'

  switch (o.kind) {
    case 'rect':
      ops.push(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re ${paint}`)
      break
    case 'ellipse':
      ops.push(ellipsePath(x, y, w, h), paint)
      break
    case 'line':
      ops.push(`${num(x)} ${num(y)} m ${num(x + w)} ${num(y + h)} l S`)
      break
    case 'arrow':
      // The head is filled with the stroke colour so shaft and head match.
      if (o.stroke) ops.push(fillColor(o.stroke))
      ops.push(arrowPath(x, y, w, h))
      break
  }

  appendContent(ctx.raw, ctx.page, ops.join('\n'))
}
```

Register in `write/index.ts`:

```ts
import { writeShape } from './objects/shape.js'
WRITERS.rect = writeShape
WRITERS.ellipse = writeShape
WRITERS.line = writeShape
WRITERS.arrow = writeShape
```

- [ ] **Step 4: Run the writer tests**

Run: `pnpm vitest run --project pdf-core shape`
Expected: PASS. The golden is created on this first local run — **open `packages/pdf-core/test/golden/export-shapes.png` and look at it** before committing. A golden accepted without being viewed is worthless.

- [ ] **Step 5: Implement the drawing tool**

Create `apps/web/src/features/overlay/useDrawTool.ts`. On `pointerdown` over a page, convert the point to PDF space with `viewToPdf`, track the drag, publish a live `Draft` to the tools store, and on `pointerup` commit one `addObject` op with `z: edits.nextZ()`. Reuse `useDragGesture` rather than adding a second pointer implementation. A drag under 3pt in both axes is discarded as a stray click rather than committing a zero-size object.

Create `EllipseObject.vue`, `LineObject.vue`, `ArrowObject.vue` mirroring `RectObject.vue` — `<ellipse>`, `<line>`, and a `<path>` respectively, all reading raw PDF coordinates with `vector-effect="non-scaling-stroke"`. Register all four in `ObjectLayer.vue`'s `COMPONENTS` map and their fields in `inspectorFields.ts` (already present from Task 28).

- [ ] **Step 6: Write the drawing test**

`apps/web/test/features/drawShapes.test.ts` — mount `PageOverlay` with the `rect` tool active, dispatch pointerdown/move/up, assert exactly one object exists with the expected PDF-space rect, assert one history entry, and assert a 1px drag creates nothing.

- [ ] **Step 7: Run everything and commit**

```bash
git add packages/pdf-core/src/write/objects/shape.ts packages/pdf-core/src/write/index.ts packages/pdf-core/test/write packages/pdf-core/test/golden/export-shapes.png apps/web/src/features apps/web/test
git commit -m "feat: shape tools with content-stream export and golden test

First tool through the full pipeline established in Task 24: overlay
renderer, inspector fields, object writer, golden export test.

Arrowheads are computed geometry drawn in the same content stream as
the shaft, not an annotation feature -- so head and shaft can never
separate."
```

---
## Task 30: Whiteout

An opaque filled rect above existing content. **Named honestly**: it covers, it does not remove. The underlying text remains extractable by any PDF tool, and the UI must say so — conflating this with redaction is a real user-harm risk (people white out SSNs and believe they are gone). Real removal is Phase 6's `applyRedactions()` path.

**Files:**
- Create: `apps/web/src/features/overlay/objects/WhiteoutObject.vue`, `packages/pdf-core/src/write/objects/whiteout.ts`
- Modify: `ObjectLayer.vue`, `write/index.ts`, `Inspector.vue` (the honesty note)
- Test: `packages/pdf-core/test/write/whiteout.test.ts`, `apps/web/test/features/whiteoutHonesty.test.ts`

**Interfaces:**
- Produces: `writeWhiteout: ObjectWriter` registered for `whiteout`

- [ ] **Step 1: Write the failing writer test**

Create `packages/pdf-core/test/write/whiteout.test.ts` using the same `docWith`/`sample` helpers shown in Task 29 (copy them; do not import across test files):

```ts
it('covers existing text with an opaque fill', () => {
  const src = bytes('simple-text')
  const geom = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }
  const out = replay(src, docWith([{
    pageId: 'p0', id: 'w1', kind: 'whiteout',
    rect: { x: 0, y: 0, w: 612, h: 792 },
    rotation: 0, z: 1, locked: false, opacity: 1, fill: [1, 1, 1],
  } as EditObject]))
  // A full-page cover means no dark pixels survive anywhere.
  const doc = PdfDocument.open(out)
  try {
    const { rgba } = renderPage(doc, 0, 1)
    let dark = 0
    for (let i = 0; i < rgba.length; i += 4) if (rgba[i]! < 128) dark++
    expect(dark).toBe(0)
  } finally { doc.close() }
})

it('does NOT remove the underlying text — it is still extractable', () => {
  const src = bytes('simple-text')
  const out = replay(src, docWith([{
    pageId: 'p0', id: 'w1', kind: 'whiteout',
    rect: { x: 0, y: 0, w: 612, h: 792 },
    rotation: 0, z: 1, locked: false, opacity: 1, fill: [1, 1, 1],
  } as EditObject]))
  const doc = PdfDocument.open(out)
  try {
    const page = doc._raw().loadPage(0)
    try {
      const text = page.toStructuredText('').asJSON()
      // This assertion is the FEATURE, not a bug. Whiteout is cosmetic and
      // this test is the executable record of that. If a future change made
      // this test fail, the tool would have silently become a redaction
      // tool -- and the UI copy promising otherwise would be a lie.
      expect(text.length).toBeGreaterThan(2)
    } finally { page.destroy() }
  } finally { doc.close() }
})
```

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement the writer**

Create `packages/pdf-core/src/write/objects/whiteout.ts`:

```ts
import type { ObjectWriter } from '../index.js'
import type { WhiteoutObject } from '../types.js'
import { appendContent, fillColor, alphaState } from '../content.js'
import { toContentSpace, num } from '../coords.js'

/**
 * An opaque rect drawn ABOVE existing content.
 *
 * This covers; it does not remove. The text underneath is still in the
 * content stream and still extractable -- see the "does NOT remove"
 * assertion in whiteout.test.ts, which is a specification, not an
 * oversight. Genuine removal is Phase 6's applyRedactions() path.
 */
export const writeWhiteout: ObjectWriter = (ctx, object) => {
  const o = object as WhiteoutObject
  const { x, y, w, h } = toContentSpace(o.rect)
  const ops: string[] = []
  if (o.opacity < 1) ops.push(alphaState(ctx.raw, ctx.page, `gs${o.id}`, o.opacity))
  ops.push(fillColor(o.fill), `${num(x)} ${num(y)} ${num(w)} ${num(h)} re f`)
  appendContent(ctx.raw, ctx.page, ops.join('\n'))
}
```

Register `WRITERS.whiteout = writeWhiteout` in `write/index.ts`.

- [ ] **Step 4: Create the overlay component**

`WhiteoutObject.vue` renders an SVG `<rect>` with `:fill` from the object and no stroke, reading raw PDF coordinates exactly as `RectObject.vue` does. Register it in `ObjectLayer.vue`'s `COMPONENTS` map.

- [ ] **Step 5: Add the honesty copy and its test**

In `Inspector.vue`, when the selected object's kind is `whiteout`, render:

> Whiteout covers content — it does not delete it. The text underneath can still be copied out of the file.

Create `apps/web/test/features/whiteoutHonesty.test.ts` asserting that selecting a whiteout object renders copy containing "does not delete", and that the word "redact" appears nowhere in the Inspector's output.

- [ ] **Step 6: Run everything and commit**

```bash
git add packages/pdf-core/src/write/objects/whiteout.ts packages/pdf-core/src/write/index.ts packages/pdf-core/test/write/whiteout.test.ts apps/web/src/features apps/web/test
git commit -m "feat: whiteout tool, named and documented honestly

Draws an opaque rect above existing content. A test asserts the covered
text is STILL extractable -- that is the specification, not a defect --
and the inspector says so in plain words. Conflating cover with redact
is a real user-harm risk (spec 2.1); genuine removal is Phase 6."
```

---

## Task 31: Text

The largest tool task. Three things have to agree: what the user sees while typing, what the SVG overlay renders, and what the exported content stream draws. Phase 0 established that `FreeText` cannot be used here — it silently ignores any font outside the standard 14, and the curated set is entirely non-base-14 — so text is drawn as content-stream operators via `Font` + `addSimpleFont`.

**Files:**
- Create: `apps/web/public/fonts/*.ttf` (curated set), `apps/web/src/lib/fonts.ts`
- Create: `apps/web/src/features/overlay/objects/TextObject.vue`, `features/overlay/TextEditor.vue`
- Create: `packages/pdf-core/src/write/objects/text.ts`, `packages/pdf-core/src/write/fonts.ts`
- Modify: `write/index.ts` (`replay` gains a font provider), `pdfService.ts`, `ObjectLayer.vue`
- Test: `packages/pdf-core/test/write/text.test.ts`, `apps/web/test/lib/fonts.test.ts`, `apps/web/test/features/TextEditor.test.ts`

**Interfaces:**
- Produces:
  - `writeText: ObjectWriter` registered for `text`
  - `replay(sourceBytes, editDoc, opts?: { fonts?: Map<string, Uint8Array> })` — **this widens Task 24's signature**; the third parameter is optional and every existing call site stays valid
  - `loadFont(family: string): Promise<void>` and `measureText(text, family, size): number` from `@/lib/fonts`

- [ ] **Step 1: Add the curated fonts**

Download Inter, Roboto, Source Serif 4, Merriweather, and JetBrains Mono (all SIL Open Font License) into `apps/web/public/fonts/`. Self-hosted, not a CDN, so preview and export use byte-identical files and no third-party request is made per document (spec §2.5). Record each font's licence in `apps/web/public/fonts/LICENSES.md`.

- [ ] **Step 2: Write the failing font-embedding test**

Create `packages/pdf-core/test/write/text.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { replay } from '../../src/write/index.js'
import { PdfDocument } from '../../src/index.js'
import { assertGolden } from '../golden.js'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const FONTS = new Map([
  ['Inter', new Uint8Array(readFileSync(join(ROOT, 'apps/web/public/fonts/Inter-Regular.ttf')))],
])

describe('text writer', () => {
  const src = bytes('simple-text')

  it('draws text that is extractable from the exported file', () => {
    const out = replay(src, docWith([textObject('Hello margin')]), { fonts: FONTS })
    const doc = PdfDocument.open(out)
    try {
      const page = doc._raw().loadPage(0)
      try {
        expect(page.toStructuredText('').asJSON()).toContain('Hello margin')
      } finally { page.destroy() }
    } finally { doc.close() }
  })

  it('embeds the custom font rather than silently falling back', () => {
    const out = replay(src, docWith([textObject('Hello')]), { fonts: FONTS })
    // A registered font costs 57-65% of its raw size (Phase 0, measured), so
    // an embed is unmistakable against an un-embedded baseline.
    const bare = replay(src, docWith([]), { fonts: FONTS })
    expect(out.byteLength).toBeGreaterThan(bare.byteLength + 50_000)
  })

  it('escapes characters that would terminate a PDF string literal', () => {
    const out = replay(src, docWith([textObject('a(b)c\\d')]), { fonts: FONTS })
    const doc = PdfDocument.open(out)
    try {
      const page = doc._raw().loadPage(0)
      try {
        expect(page.toStructuredText('').asJSON()).toContain('a(b)c')
      } finally { page.destroy() }
    } finally { doc.close() }
  })

  it('throws a named error when the font was never provided', () => {
    expect(() => replay(src, docWith([textObject('x')]), { fonts: new Map() }))
      .toThrow(/Inter/)
  })

  it('matches the reviewed golden', async () => {
    await assertGolden('export-text', replay(src, docWith([
      textObject('Left aligned', 'left'),
      textObject('Centred', 'center'),
      textObject('Right aligned', 'right'),
    ]), { fonts: FONTS }))
  })
})
```

Define `textObject(text, align = 'left')` in the file returning a `TextObject` with `fontFamily: 'Inter'`, `fontSize: 18`, `color: [0,0,0]`, and a rect placed clear of the fixture's own text.

- [ ] **Step 3: Run it — expect FAIL**

- [ ] **Step 4: Implement font registration**

Create `packages/pdf-core/src/write/fonts.ts`:

```ts
import * as mupdf from 'mupdf'

export type FontProvider = Map<string, Uint8Array>

/**
 * Register a font once per document and return the resource name to use.
 *
 * NO SUBSETTING. Phase 0 measured that addSimpleFont embeds the entire font
 * program, Flate-compressed only, at 57-65% of raw bytes, and that
 * doc.subsetFonts() makes zero difference for a freshly registered font.
 * Subsetting via pdf-lib + @pdf-lib/fontkit is deliberately deferred to
 * Phase 4 (PHASE-2-DESIGN.md section 0) -- it is a size optimisation, not a
 * capability, and keeping a second PDF library out of the export path while
 * that path is still being proven is worth roughly 180KB per document.
 *
 * 'Latin' encoding means non-Latin scripts are out of scope this phase.
 * That is a known, stated limitation, not an oversight.
 */
export class FontRegistry {
  #cache = new Map<string, { name: string; obj: mupdf.PDFObject }>()

  constructor(private raw: mupdf.PDFDocument, private provider: FontProvider) {}

  resolve(family: string): { name: string; obj: mupdf.PDFObject } {
    const hit = this.#cache.get(family)
    if (hit) return hit
    const bytes = this.provider.get(family)
    if (!bytes) {
      // Never substitute silently: text drawn in an unexpected face looks
      // subtly wrong and nobody notices until it is printed.
      throw new Error(
        `font "${family}" was not provided to the export. Load it before exporting.`,
      )
    }
    const font = new mupdf.Font(family, bytes)
    const obj = this.raw.addSimpleFont(font, 'Latin')
    const entry = { name: `F${this.#cache.size + 1}`, obj }
    this.#cache.set(family, entry)
    return entry
  }
}

/** Escape a PDF literal string: backslash and both parentheses. */
export function pdfString(s: string): string {
  return `(${s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`
}
```

- [ ] **Step 5: Implement the text writer**

Create `packages/pdf-core/src/write/objects/text.ts`:

```ts
import type { ObjectWriter } from '../index.js'
import type { TextObject } from '../types.js'
import { appendContent, addResource, fillColor, alphaState } from '../content.js'
import { toContentSpace, num } from '../coords.js'
import { pdfString } from '../fonts.js'

/** Baseline sits this fraction of the font size below the line's top. */
const ASCENT_RATIO = 0.8
const LINE_HEIGHT = 1.2

export const writeText: ObjectWriter = (ctx, object) => {
  const o = object as TextObject
  const { x, y, w, h } = toContentSpace(o.rect)
  const font = ctx.fonts.resolve(o.fontFamily)
  addResource(ctx.raw, ctx.page, 'Font', font.name, font.obj)

  const lines = o.text.split('\n')
  const ops: string[] = []
  if (o.opacity < 1) ops.push(alphaState(ctx.raw, ctx.page, `gs${o.id}`, o.opacity))
  ops.push(fillColor(o.color), 'BT', `/${font.name} ${num(o.fontSize)} Tf`)

  lines.forEach((line, i) => {
    // PDF text origin is the BASELINE, and the box's y is its bottom edge,
    // so lines are laid out downward from the box top.
    const baseline = y + h - o.fontSize * ASCENT_RATIO - i * o.fontSize * LINE_HEIGHT
    const advance = ctx.measure(line, o.fontFamily, o.fontSize)
    const offset = o.align === 'center' ? (w - advance) / 2 : o.align === 'right' ? w - advance : 0
    ops.push(`1 0 0 1 ${num(x + offset)} ${num(baseline)} Tm`, `${pdfString(line)} Tj`)
  })

  ops.push('ET')
  appendContent(ctx.raw, ctx.page, ops.join('\n'))
}
```

- [ ] **Step 6: Widen `WriteContext` and `replay`**

In `write/index.ts`, add `fonts: FontRegistry` and `measure: (text: string, family: string, size: number) => number` to `WriteContext`; construct the registry once per `replay` call; and add the third parameter:

```ts
export function replay(
  sourceBytes: Uint8Array,
  editDoc: EditDocument,
  opts: { fonts?: FontProvider } = {},
): Uint8Array
```

Measurement uses MuPDF's own glyph advances so preview and export agree — Phase 0 verified `font.advanceGlyph(font.encodeCharacter(ch)) * size` matches `showString`'s advance to 5 decimal places:

```ts
function measurer(provider: FontProvider) {
  const cache = new Map<string, mupdf.Font>()
  return (text: string, family: string, size: number): number => {
    let font = cache.get(family)
    if (!font) {
      const bytes = provider.get(family)
      if (!bytes) throw new Error(`font "${family}" was not provided to the export.`)
      font = new mupdf.Font(family, bytes)
      cache.set(family, font)
    }
    let total = 0
    for (const ch of text) total += font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0)!))
    return total * size
  }
}
```

- [ ] **Step 7: Implement the browser font layer**

Populate the `fontFamily` select in `inspectorFields.ts`, which Task 28 deliberately shipped with `options: []` because no fonts existed yet — fill it from the curated set added in Step 1, or the font picker renders as an empty dropdown.

Create `apps/web/src/lib/fonts.ts` — `loadFont(family)` constructs a `FontFace` from `/fonts/<family>-Regular.ttf`, adds it to `document.fonts`, and caches the promise; `measureText(text, family, size)` measures via a canvas 2D context. `fontBytes(family)` fetches the same file as an `ArrayBuffer` for the worker. **Preview must equal export**: the same file feeds both, per spec §2.5.

`TopBar.vue`'s `download()` gathers the families in use and passes their bytes:

```ts
const families = new Set(
  Object.values(edits.doc.objects)
    .filter((o) => o.kind === 'text')
    .map((o) => (o as TextObject).fontFamily),
)
const fonts = new Map(await Promise.all([...families].map(async (f) => [f, await fontBytes(f)] as const)))
const bytes = await getPdfClient().save(edits.doc, fonts)
```

- [ ] **Step 8: Implement the overlay and editor**

`TextObject.vue` renders an SVG `<text>` per line. Because the overlay's root `<g>` carries a y-flip, text drawn inside it would appear mirrored — counter it with a local `transform="scale(1,-1)"` on the text element and negate its y. `TextEditor.vue` is an absolutely-positioned `contenteditable` in Layer 3 (DOM, not SVG — SVG text editing breaks IME and mobile keyboards), committing through `withTransaction` on 400ms idle or blur.

- [ ] **Step 9: Run the tests, review the golden by eye, commit**

```bash
git add apps/web/public/fonts apps/web/src/lib/fonts.ts packages/pdf-core/src/write apps/web/src/features packages/pdf-core/test apps/web/test
git commit -m "feat: text tool drawn as content-stream operators

FreeText is not used: Phase 0 measured that it silently ignores any font
outside the standard 14, and the curated self-hosted set is entirely
non-base-14, so the default font would fall off that cliff.

Measurement uses MuPDF's own glyph advances, which Phase 0 verified
match showString to 5 decimal places -- so the SVG preview and the
exported content stream agree on where text ends.

No subsetting: a registered font costs 57-65% of its raw bytes.
Deferred to Phase 4 with pdf-lib + fontkit."
```

---

## Task 32: Image

**Files:** create `write/objects/image.ts`, `features/overlay/objects/ImageObject.vue`, `features/tools/importImage.ts`; modify `ObjectLayer.vue`, `write/index.ts`; test `packages/pdf-core/test/write/image.test.ts`, `apps/web/test/features/importImage.test.ts`

**Interfaces:** produces `writeImage: ObjectWriter` for `image`; `importImage(file: File): Promise<{ data: Uint8Array; mime: 'image/png'|'image/jpeg'; w: number; h: number }>`

- [ ] **Step 1: Failing writer test** — assert the exported file grows by roughly the image payload, that the drawn region samples the image's dominant colour at the expected view coordinates, and that a second object reusing the same bytes does **not** double the file size (the XObject must be shared, keyed by a hash of the bytes).

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement the writer**

```ts
import * as mupdf from 'mupdf'
import type { ObjectWriter } from '../index.js'
import type { ImageObject } from '../types.js'
import { appendContent, addResource, alphaState } from '../content.js'
import { toContentSpace, num } from '../coords.js'

export const writeImage: ObjectWriter = (ctx, object) => {
  const o = object as ImageObject
  const { x, y, w, h } = toContentSpace(o.rect)
  // Memoised on a hash of the bytes, so N copies of one image embed once.
  const { name, obj } = ctx.xobject(o.data, () => ctx.raw.addImage(new mupdf.Image(o.data)))
  addResource(ctx.raw, ctx.page, 'XObject', name, obj)
  const ops: string[] = []
  if (o.opacity < 1) ops.push(alphaState(ctx.raw, ctx.page, `gs${o.id}`, o.opacity))
  // The image XObject's own space is the unit square, so the CTM carries
  // position and size: [w 0 0 h x y].
  ops.push(`${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm`, `/${name} Do`)
  appendContent(ctx.raw, ctx.page, ops.join('\n'))
}
```

Add `xobject(bytes: Uint8Array, create: () => mupdf.PDFObject): { name: string; obj: mupdf.PDFObject }` to `WriteContext` — a memo keyed by an FNV-1a hash of the bytes, returning a stable resource name. This is the third and final widening of `WriteContext` in this plan (after Task 31's `fonts` and `measure`).

- [ ] **Step 4: Implement client-side import**

`importImage(file)` decodes via `createImageBitmap`, honours EXIF orientation, downscales so the longest edge is at most 2000px, and re-encodes to JPEG at quality 0.85 (PNG when the source has alpha). **A 12MP phone photo dropped on a page must not become a 4MB embed** (spec §2.1). Reject files over 25MB with a named error.

- [ ] **Step 5: Overlay component** — `ImageObject.vue` renders `<image>` with an object-URL href, `preserveAspectRatio="none"`, and a local `scale(1,-1)` to counter the root y-flip. Revoke the URL on unmount.

- [ ] **Step 6: Run everything, review the golden, commit**

---

## Task 33: Freehand ink

Exports as a **native `Ink` annotation** (semantic split: ink is an annotation, so it stays editable and removable in other PDF tools). Phase 0 confirmed `Ink` renders with an auto-generated `/AP`, pixel-identical between MuPDF and Apple CoreGraphics.

**Files:** create `write/objects/ink.ts`, `features/overlay/InkCanvas.vue`, `features/overlay/objects/InkObject.vue`; modify `write/index.ts`, `ObjectLayer.vue`; add `perfect-freehand`; test `packages/pdf-core/test/write/ink.test.ts`, `apps/web/test/features/InkCanvas.test.ts`

- [ ] **Step 1:** `pnpm --filter @margin/web add perfect-freehand`

- [ ] **Step 2: Failing writer test** — build an ink object with two strokes, replay, reopen, and assert `page.getAnnotations()` contains one annotation whose type is `Ink`, whose `/AP` is a dictionary, and whose rendered pixels are non-white along the stroke path.

- [ ] **Step 3: Implement the writer**

```ts
import type { ObjectWriter } from '../index.js'
import type { InkObject } from '../types.js'
import { toAnnotSpace } from '../coords.js'
import { pdfToView } from '@margin/transform'

/**
 * CONVENTION A applies here, not B: setInkList/setRect are annotation
 * setters, so points go in page space at scale 1 with no manual flip.
 * Passing raw bottom-up PDF points would mirror every stroke vertically --
 * and on an unrotated letter page it would still look like a plausible
 * squiggle, which is exactly why this is pinned by a test.
 */
export const writeInk: ObjectWriter = (ctx, object) => {
  const o = object as InkObject
  const annot = ctx.page.createAnnotation('Ink')
  annot.setRect(toAnnotSpace(o.rect, ctx.geometry))
  annot.setColor(o.color)
  annot.setBorderWidth(o.strokeWidth)
  annot.setOpacity(o.opacity)
  annot.setInkList(
    o.strokes.map((flat) => {
      const pts: number[] = []
      for (let i = 0; i < flat.length; i += 2) {
        const v = pdfToView({ x: flat[i]!, y: flat[i + 1]! }, ctx.geometry, 1)
        pts.push(v.x, v.y)
      }
      return pts
    }),
  )
  annot.update()
}
```

Verify `setInkList`'s exact parameter shape against `node_modules/.pnpm/mupdf@1.28.0/node_modules/mupdf/dist/mupdf.d.ts` before writing the implementation — the typing is the ground truth Phase 0 used throughout, and a flat-vs-nested mismatch fails loudly at the first test run.

- [ ] **Step 4: Implement the transient canvas**

`InkCanvas.vue` collects the raw pointer stream into a plain array (**never** reactive state — pushing thousands of points into Pinia per stroke is what tanks framerate in naive implementations), draws the in-flight stroke with `perfect-freehand` on a transient `<canvas>`, and on `pointerup` commits **one** `ink` object through `applyOp`. Points convert to PDF space via `viewToPdf` at commit time only.

- [ ] **Step 5: Run everything, review the golden, commit**

---

## Task 34: Links

Uses `page.createLink(bbox, uri)` — the `fz_link` API, **not** `createAnnotation('Link')`. Phase 0 measured that a `Link` annotation rejects `setRect()`/`getRect()` with an ordinary catchable `Error`, and that the low-level `getObject().put('Rect', …)` escape hatch succeeds but is functionally inert.

`fz_link` has no `/AP` concept — link hotspots are invisible by design, per the PDF spec — so **the overlay must draw its own affordance**; MuPDF gives no rendered rectangle for free.

**Files:** create `write/objects/link.ts`, `write/links.ts`, `features/overlay/objects/LinkObject.vue`; modify `write/index.ts`, `ObjectLayer.vue`, `stores/edits.ts` (URL validation); test `packages/pdf-core/test/write/link.test.ts`, `apps/web/test/lib/linkUrl.test.ts`

- [ ] **Step 1: Failing URL-validation test**

```ts
describe('normalizeUri', () => {
  it('accepts http and https', () => {
    expect(normalizeUri('https://example.com')).toBe('https://example.com/')
  })
  it('adds https:// to a bare domain', () => {
    expect(normalizeUri('example.com/a')).toBe('https://example.com/a')
  })
  it('accepts mailto:', () => {
    expect(normalizeUri('mailto:a@b.com')).toBe('mailto:a@b.com')
  })
  // Blocking javascript: is a security requirement (spec 2.1), enforced at
  // op-creation time so an invalid link can never reach the export path.
  it.each(['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:x', 'data:text/html,x', 'vbscript:x'])(
    'rejects %s', (bad) => expect(() => normalizeUri(bad)).toThrow(/not allowed/i),
  )
  it('rejects unparseable input', () => {
    expect(() => normalizeUri('http://')).toThrow()
  })
})
```

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement validation**

```ts
const ALLOWED = new Set(['http:', 'https:', 'mailto:', 'tel:'])

export function normalizeUri(input: string): string {
  const raw = input.trim()
  if (!raw) throw new Error('Enter a URL.')
  // Bare domains are the common case in a UI; assume https rather than
  // letting the URL parser reject them.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error('That does not look like a valid URL.')
  }
  if (!ALLOWED.has(url.protocol.toLowerCase())) {
    throw new Error(`Links using "${url.protocol}" are not allowed.`)
  }
  return url.toString()
}
```

Call it in the store when constructing a `link` op, so an invalid URL is unrepresentable rather than rejected late at export.

- [ ] **Step 4: Implement the writer**

```ts
export const writeLink: ObjectWriter = (ctx, object) => {
  const o = object as LinkObject
  // Convention A: createLink's bbox is page space at scale 1, pinned by
  // test/write/pinning.test.ts -- Phase 0 round-tripped getURI() but never
  // checked where the hotspot landed.
  ctx.page.createLink(toAnnotSpace(o.rect, ctx.geometry), o.uri)
}
```

- [ ] **Step 5: Detect existing links on load**

Extend `PdfService.open` to return each page's existing links (`page.getLinks()` → bounds + URI) so they are editable rather than invisible, per spec §2.1. Seed them into the edit store as `link` objects marked `locked: false`.

- [ ] **Step 6: Overlay affordance**

`LinkObject.vue` draws a dashed accent-coloured rect plus a small link glyph. Because `fz_link` renders nothing in the exported PDF, this affordance is **editor-only** and must not be drawn into the content stream.

- [ ] **Step 7: Run everything and commit**

---

## Task 35: Signature — draw, type, upload

**Files:** create `features/signature/SignatureModal.vue`, `removeBackground.ts`, `signatureStore.ts`; `write/objects/signature.ts`; add `dexie`; test `apps/web/test/features/removeBackground.test.ts`, `packages/pdf-core/test/write/signature.test.ts`

- [ ] **Step 1:** `pnpm --filter @margin/web add dexie`

- [ ] **Step 2: Failing background-removal test**

```ts
describe('removeBackground', () => {
  it('makes near-white pixels fully transparent', () => {
    const out = removeBackground(imageDataOf([[250, 250, 250], [10, 10, 10]]))
    expect(out.data[3]).toBe(0)    // near-white -> transparent
    expect(out.data[7]).toBe(255)  // ink -> opaque
  })

  it('ramps alpha across the threshold rather than hard-clipping', () => {
    const out = removeBackground(imageDataOf([[200, 200, 200]]))
    expect(out.data[3]).toBeGreaterThan(0)
    expect(out.data[3]).toBeLessThan(255)
  })

  it('leaves a dark photo untouched rather than erasing the signature', () => {
    const out = removeBackground(imageDataOf([[40, 40, 40], [30, 30, 30]]))
    expect(out.data[3]).toBe(255)
    expect(out.data[7]).toBe(255)
  })
})
```

- [ ] **Step 3: Implement it**

```ts
const OPAQUE_BELOW = 120
const TRANSPARENT_ABOVE = 235

/**
 * Luminance threshold -> alpha, so a phone photo of a signature on paper
 * does not paste an opaque white block over the page. Spec 2.1 is explicit
 * that without this the feature "feels broken".
 *
 * A soft ramp between the two thresholds rather than a hard cut: hard
 * clipping leaves visibly jagged, aliased stroke edges.
 */
export function removeBackground(img: ImageData): ImageData {
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!
    if (lum >= TRANSPARENT_ABOVE) d[i + 3] = 0
    else if (lum > OPAQUE_BELOW) {
      d[i + 3] = Math.round(255 * (1 - (lum - OPAQUE_BELOW) / (TRANSPARENT_ABOVE - OPAQUE_BELOW)))
    }
  }
  return img
}
```

- [ ] **Step 4: Build the modal** — three tabs. *Draw* reuses the `perfect-freehand` pipeline from Task 33 on a fixed-aspect pad. *Type* renders a text object in one of 3–4 self-hosted script faces. *Upload* runs `importImage` then `removeBackground`, showing a before/after preview so the user can see what it did.

- [ ] **Step 5: Saved signatures** — store as PNG in IndexedDB via Dexie for reuse. **Explicit opt-in only** — a signature is sensitive, and the default must be not to persist it (spec §2.1). The opt-in checkbox is unchecked by default and its label says the signature will be stored on this device.

- [ ] **Step 6: Writer** — `signature` exports through the same XObject path as `image`; register `WRITERS.signature = writeImage` rather than duplicating it, since the two differ only in provenance and inspector fields.

- [ ] **Step 7: Run everything, review the golden, commit**

---
## Task 36: The text-quad index

Selecting text drawn on a bitmap needs a geometric index of where every character is. Phase 0 established that **this takes two calls, not one** — and that no single call gives both pieces:

- `page.toStructuredText(options?).asJSON(scale?)` returns blocks → lines. Each line is **already a homogeneous-style run** with a bbox and font info (name, size, weight/italic flags). There is **no separate `spans` array** nested under a line. `asJSON()` takes only a numeric `scale`, no options string.
- **Per-character bboxes are absent from that output at every option setting.** For those, `StructuredText.walk({ onChar })` yields an **8-number quad per character** — not an axis-aligned rect, so rotated and skewed runs are representable.

**Files:** create `packages/pdf-core/src/text/index.ts`; modify `pdfService.ts` (expose `quadIndex(page)`), `pdfClient.ts`, `packages/pdf-core/src/index.ts`; test `packages/pdf-core/test/text/quadIndex.test.ts`

**Interfaces:**
- Produces:
  - `type CharQuad = { quad: [number, number, number, number, number, number, number, number]; char: string }`
  - `type LineRun = { bbox: [number, number, number, number]; text: string; font: string; size: number; chars: CharQuad[] }`
  - `type PageQuadIndex = { lines: LineRun[] }`
  - `buildQuadIndex(doc: PdfDocument, pageIndex: number): PageQuadIndex`
  - `PdfService.quadIndex(page: number): PageQuadIndex`

- [ ] **Step 1: Write the failing index test**

```ts
describe('buildQuadIndex', () => {
  it('returns one entry per line of the fixture', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    try {
      const index = buildQuadIndex(doc, 0)
      expect(index.lines.length).toBeGreaterThan(0)
      expect(index.lines[0]!.text.length).toBeGreaterThan(0)
    } finally { doc.close() }
  })

  it('carries a per-character quad for every character in a line', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    try {
      const line = buildQuadIndex(doc, 0).lines[0]!
      // walk({onChar}) is a SEPARATE call from asJSON() -- neither alone
      // gives both the run text and per-char geometry (Phase 0, measured).
      expect(line.chars).toHaveLength([...line.text].length)
      expect(line.chars[0]!.quad).toHaveLength(8)
    } finally { doc.close() }
  })

  it('reports font name and size per run', () => {
    const doc = PdfDocument.open(bytes('mixed-fonts'))
    try {
      const fonts = new Set(buildQuadIndex(doc, 0).lines.map((l) => l.font))
      expect(fonts.size).toBeGreaterThan(1)
    } finally { doc.close() }
  })

  it('produces quads inside the page bounds on a rotated page', () => {
    const doc = PdfDocument.open(bytes('rotated'))
    try {
      const index = buildQuadIndex(doc, 1)
      for (const line of index.lines) {
        for (const c of line.chars) {
          for (let i = 0; i < 8; i += 2) {
            expect(c.quad[i]).toBeGreaterThanOrEqual(-1)
            expect(c.quad[i + 1]).toBeGreaterThanOrEqual(-1)
          }
        }
      }
    } finally { doc.close() }
  })

  it('destroys the page even when extraction throws', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    try {
      expect(() => buildQuadIndex(doc, 999)).toThrow()
      // A leaked page here does not fail loudly -- it hard-crashes the WASM
      // heap several hundred pages later. Prove the finally ran by using the
      // document again.
      expect(buildQuadIndex(doc, 0).lines.length).toBeGreaterThan(0)
    } finally { doc.close() }
  })
})
```

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement it**

Read the `StructuredText` and `walk` signatures in `node_modules/.pnpm/mupdf@1.28.0/node_modules/mupdf/dist/mupdf.d.ts` first — the `.d.ts` is the ground truth Phase 0 used throughout, and the `onChar` callback's parameter shape must come from there rather than from memory. Build `lines` from `asJSON()`, then run `walk({ onChar })` and attach each character quad to the line whose bbox contains it. Wrap the whole thing in `withPage`-style `try/finally`.

All output is in **MuPDF page space** — top-down, CropBox-origin normalised, `/Rotate` applied — the same space `toPixmap`, `getBounds`, and the annotation setters use. Do **not** convert to raw PDF space here; markup annotations (Task 38) consume these quads directly, and `toAnnotSpace` expects exactly this space.

- [ ] **Step 4: Expose it through the worker** — add `quadIndex(page)` to `PdfService` and `PdfClient`, cached per page in the worker so scrolling does not re-extract.

- [ ] **Step 5: Run everything and commit**

---

## Task 37: Text selection

**Files:** create `features/overlay/TextSelectionLayer.vue`, `features/overlay/useTextSelection.ts`, `stores/selection.ts`; test `apps/web/test/features/useTextSelection.test.ts`

- [ ] **Step 1: Failing selection test** — given a stub quad index of three lines, assert that: a drag from inside line 1 to inside line 3 selects every character between the two anchors including all of line 2; a drag right-to-left selects the same range as left-to-right; a click with no drag selects nothing; and a selection reports contiguous quads merged per line rather than one quad per character.

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement `useTextSelection`** — hit-test the pointer against character quads using `element.getScreenCTM().inverse()` so the browser does the coordinate maths (spec §1.4), track anchor and focus character indices across lines, and expose `selectedQuads` merged per line. Selection state lives in its own store, **not** in `edits.ts` — it is view state and must never enter history.

- [ ] **Step 4: Render it** — `TextSelectionLayer.vue` draws the merged quads as translucent accent-coloured polygons inside the overlay's root `<g>`, so they inherit the page transform and need no coordinate maths.

- [ ] **Step 5: Run everything and commit**

---

## Task 38: Highlight, underline, strikeout

Native annotations with `/QuadPoints` — the semantic-split half of the design. Phase 0 confirmed all three produce real auto-generated `/AP` streams and render **pixel-identically** between MuPDF and Apple CoreGraphics, with no cross-renderer disagreement found. Native means they stay editable and removable in Acrobat and do not damage the page.

**Files:** create `write/objects/markup.ts`, `features/overlay/objects/MarkupObject.vue`; modify `write/index.ts`, `ObjectLayer.vue`, `SelectionToolbar.vue`; test `packages/pdf-core/test/write/markup.test.ts`

- [ ] **Step 1: Failing writer test**

```ts
describe('markup writer', () => {
  it.each([
    ['highlight', 'Highlight'],
    ['underline', 'Underline'],
    ['strikeout', 'StrikeOut'],
  ])('writes %s as a native %s annotation with an /AP', (kind, subtype) => {
    const out = replay(bytes('simple-text'), docWith([markupObject(kind)]))
    const doc = PdfDocument.open(out)
    try {
      const page = doc._raw().loadPage(0)
      try {
        const annots = page.getAnnotations()
        expect(annots).toHaveLength(1)
        expect(annots[0]!.getType()).toBe(subtype)
        // Phase 0 verified /AP is a real written stream, not viewer-side
        // synthesis, for all three of these types.
        expect(annots[0]!.getObject().get('AP').isDictionary()).toBe(true)
      } finally { page.destroy() }
    } finally { doc.close() }
  })

  it('survives a save/reopen round trip with its quads intact', () => {
    const obj = markupObject('highlight')
    const out = replay(bytes('simple-text'), docWith([obj]))
    const doc = PdfDocument.open(out)
    try {
      const page = doc._raw().loadPage(0)
      try {
        expect(page.getAnnotations()[0]!.getQuadPoints()).toHaveLength(obj.quads.length)
      } finally { page.destroy() }
    } finally { doc.close() }
  })

  it('tints the page where a highlight sits', () => {
    const out = replay(bytes('simple-text'), docWith([markupObject('highlight')]))
    const px = sample(out, /* centre of the quad in view space */ 120, 100)
    expect(px.r).toBeGreaterThan(200)
    expect(px.b).toBeLessThan(180)
  })

  it('matches the reviewed golden', async () => {
    await assertGolden('export-markup', replay(bytes('simple-text'), docWith([
      markupObject('highlight'), markupObject('underline'), markupObject('strikeout'),
    ])))
  })
})
```

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement the writer**

```ts
import type { ObjectWriter } from '../index.js'
import type { MarkupObject } from '../types.js'
import { toAnnotSpace } from '../coords.js'

const SUBTYPE = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'StrikeOut',
} as const

/**
 * CONVENTION A. Quads arrive from buildQuadIndex already in MuPDF page
 * space, which is exactly what setQuadPoints expects -- do not convert them
 * again. Only `rect` needs toAnnotSpace, because it is stored in raw PDF
 * space like every other object rect.
 */
export const writeMarkup: ObjectWriter = (ctx, object) => {
  const o = object as MarkupObject
  const annot = ctx.page.createAnnotation(SUBTYPE[o.kind])
  annot.setRect(toAnnotSpace(o.rect, ctx.geometry))
  annot.setQuadPoints(o.quads)
  annot.setColor(o.color)
  annot.setOpacity(o.opacity)
  // update() is what generates the /AP. Without it the annotation exists in
  // the file but renders as nothing in most viewers.
  annot.update()
}
```

Register all three kinds in `WRITERS`.

- [ ] **Step 4: Overlay component and toolbar wiring** — `MarkupObject.vue` draws the quads as polygons (translucent fill for highlight, a bottom-edge line for underline, a mid-height line for strikeout). Add the three actions to `SelectionToolbar.vue`, enabled only when a text selection exists, each committing one `addObject` op built from `selectedQuads`.

- [ ] **Step 5: Run everything, review the golden, commit**

---

## Task 39: Export progress, error surfaces, and large documents

**Files:** modify `pdfService.ts`, `pdfClient.ts`, `TopBar.vue`; create `features/document/ExportError.vue`; test `apps/web/test/features/exportErrors.test.ts`

- [ ] **Step 1: Failing error-handling tests**

Assert that: a writer throwing mid-replay rejects the whole export and no download is triggered (**never hand the user a partial PDF that silently dropped their signature**); the surfaced message names the failing object's kind and page; a missing font produces the named font error from Task 31 rather than a generic failure; and the Download button returns to its idle state after a failure so the user can retry.

- [ ] **Step 2: Implement progress reporting** — `save` accepts a Comlink-proxied `onProgress(done, total)` callback invoked per page. The button shows a determinate state for documents over 20 pages. Because MuPDF work is synchronous inside WASM, yield to the event loop between pages so progress actually paints.

- [ ] **Step 3: Add an export timeout** — the existing `pdfClient` readiness handshake covers boot only. Wrap `save` in a timeout that surfaces a retryable error rather than leaving the button spinning forever.

- [ ] **Step 4: Measure a large document** — export `large-300p.pdf` with 50 objects spread across it and record the wall-clock time in `docs/findings/`. Phase 0's baseline is 827.9 pages/sec at 1.0× for *rendering*; export has never been measured, and a number in the findings is worth more than an assumption.

- [ ] **Step 5: Run everything and commit**

---

## Task 40: Full golden suite and cross-viewer verification

**Files:** create `packages/pdf-core/test/write/suite.test.ts`, `docs/findings/05-phase-2-verification.md`; modify `apps/web/e2e/edit.spec.ts`

- [ ] **Step 1: Write the combined golden test** — one `EditDocument` containing every object kind at once, replayed onto `simple-text.pdf`, `offset-cropbox.pdf`, and `rotated.pdf`, each compared against a reviewed golden. This is the regression net for the whole phase: a coordinate change that only shows up on rotated or offset pages fails here.

- [ ] **Step 2: Write the end-to-end edit spec**

`apps/web/e2e/edit.spec.ts`: open a PDF, draw a rectangle, type text, undo twice, redo once, download, and assert the downloaded bytes reopen with exactly the expected objects present.

- [ ] **Step 3: Confirm every new golden is tracked, and no artifact is**

`.gitignore:7-9` already excludes `*.actual.png`, `*.diff.png`, and `_scratch-*` under `test/golden/`, and the stray `simple-text-p0.actual.png` / `.diff.png` sitting in that directory are correctly untracked — nothing to clean up there. What this step checks is the opposite direction: run `git ls-files packages/pdf-core/test/golden/` and confirm every baseline this phase added (`export-shapes.png`, `export-text.png`, `export-markup.png`, and Task 40's per-fixture goldens) is actually committed. A golden that exists only on the machine that generated it makes CI throw rather than silently pass — `assertGolden` fails loudly on a missing golden under CI by design — but it still means the regression net has a hole locally.

- [ ] **Step 4: Human verification — this cannot be automated**

Phase 0 verified native annotations across MuPDF and Apple CoreGraphics and found them pixel-identical with no disagreement. **Acrobat and Chrome were never opened**, because that environment had no GUI. PLAN.md's Phase 2 milestone names all three viewers explicitly, so this is a release gate, not a nice-to-have.

Produce `docs/findings/05-phase-2-verification.md` with a table of every object kind × {Acrobat, Preview, Chrome} and export the sample files to open. `docs/findings/evidence/out-annots.pdf` already exists and covers the annotation half. Record honest results — `NOT VERIFIED` is a legitimate entry and is what Phase 0 used rather than inferring a pass.

Check specifically:
- Highlights, underlines, and strikeouts are **selectable and deletable** in Acrobat (that is the entire point of the semantic split).
- Custom-font text renders in the intended face, not a substituted one.
- Images and signatures show correct transparency — a signature with a white block behind it means `removeBackground` did not run.
- Links are clickable and go where they should.

- [ ] **Step 5: Update the roadmap** — mark Phase 2 complete in `PLAN.md` §7 with a one-line pointer to the verification findings, matching how Phase 0 is recorded.

- [ ] **Step 6: Final full run**

```bash
pnpm test && pnpm typecheck && pnpm --filter @margin/web typecheck && pnpm --filter @margin/web build && pnpm --filter @margin/web e2e
```

- [ ] **Step 7: Commit and open the phase branch for review**

```bash
git add -A
git commit -m "test: full Phase 2 golden suite and cross-viewer verification record"
```

---

## Plan self-review

Run against `PHASE-2-DESIGN.md` after writing, before execution.

**Spec coverage — every design section maps to a task:**

| Design section | Tasks |
|---|---|
| §0 build order: export spine first | 22, 23, 24 |
| §0 semantic split | 29-35 (content stream) · 33, 38 (native annots) · 34 (createLink) |
| §0 pristine bytes retained | 22 |
| §0 trims: no subsetting, no snapping | 31 (stated in `fonts.ts`) · 26 (stated in the commit) |
| §1.1 new file layout | 22-38, per the File Structure table |
| §1.2 edit store, three explicit calls | 23 |
| §1.3 three-layer overlay | 25 (Layer 2) · 26 (Layer 3) · 33 (transient canvas) |
| §2 write path and disposal discipline | 24 (`session.ts`) |
| §3 the two coordinate conventions | 24 (`coords.ts` + pinning tests) |
| §4 data flow | 22 (download path) · 39 (progress) |
| §5 error handling table | 39, plus per-tool tests |
| §6 four testing layers | store 23 · writers 29-38 · goldens 29, 31, 38, 40 · e2e 22, 40 |
| §6 human verification gate | 40 |
| §7 task sequence | 22-40, unchanged |
| §9 housekeeping | 22 (`.nvmrc`, Download tooltip) · 40 (golden artifacts) |

**Type consistency:** `EditDocument`, `EditObject`, `Op`, `ObjectKind` are defined once in Task 23 (`write/types.ts`) and imported everywhere after. `ObjectWriter` and `WriteContext` are defined in Task 24 and widened once, explicitly, in Task 31 (`fonts`, `measure`) and Task 32 (`xobject`) — both flagged in their task text rather than silently assumed. `replay`'s signature gains its optional third parameter in Task 31, and every earlier call site remains valid.

**Known gaps, stated rather than hidden:**

1. **`setInkList` and `walk({ onChar })` parameter shapes are not pinned in this plan.** Tasks 33 and 36 instruct the executor to read `mupdf.d.ts` first. Phase 0 used that file as ground truth throughout and this plan does the same rather than guessing a signature into a code block.
2. **Convention B may be wrong.** Task 24 Step 8 says explicitly what to do if the pinning test fails — fix `coords.ts`, do not adjust the test — and why that is a one-file change at that point in the sequence.
3. **Non-Latin text is out of scope.** `addSimpleFont(font, 'Latin')` is what Task 31 uses. Stated in `fonts.ts`, not discovered later.
4. **Acrobat and Chrome cannot be verified by any agent.** Task 40 Step 4 is a human step, marked as a release gate.

---

## Execution handoff

**Plan complete and saved to `PLAN-PHASE-2.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task with review between tasks. Suits this plan because Tasks 29-35 share one shape (overlay renderer · inspector fields · object writer · golden test) and are well isolated from each other, and several are long enough to want a clean context.

**2. Inline Execution** — tasks executed in this session with batched checkpoints.

**Which approach?**

Two caveats either way:

- **Tasks 29, 31, 38, and 40 create golden images.** An agent can generate a PNG and see the test go green; it cannot judge whether a highlight *looks right*. Review each new golden by eye before committing it, or those baselines record whatever the code did on the day rather than what it should do.
- **Task 40 Step 4 requires opening files in Acrobat and Chrome.** No agent can do this. It is the phase's release gate and Phase 0 left it outstanding for exactly the same reason.
