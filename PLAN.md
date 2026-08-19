# get-margin — Architecture & Build Plan

Web-based PDF editor with feature parity to Sejda's editor (referenced for *feature scope only* — no UI/UX or visual borrowing). Original modern-SaaS design.

**Status:** Phase 0 complete (11 tasks, 77 tests passing, spikes retired). Amended throughout to match measured engine reality — see `docs/findings/00-phase-0-decisions.md`. Phase 1 not yet started.
**Date:** 2026-08-17 (original) · amended 2026-08-18

---

## 0. Decisions already locked

| Area | Decision |
|---|---|
| Frontend | Vue 3 (Composition API) + Vite + Tailwind CSS |
| PDF engine | MuPDF.js (WASM) in a Web Worker; same package reused in Node for tests |
| Backend | Node + Fastify (phase 7-heavy; MVP barely needs it) |
| OCR | Tesseract (via `ocrmypdf` wrapper — see §5) |
| Office conversion | LibreOffice headless (via `unoserver` daemon) |
| HTML → PDF | Playwright headless |
| Persistence | **Ephemeral MVP** — no accounts, no server-side doc storage. A `DocumentStore` seam is designed in so cloud save can land later without rewriting state. |
| Team / pace | Solo dev, full-time, AI-assisted |
| Devices | **Fully responsive down to phone** (two shells, one state layer) |
| Existing-text editing | **Line/span-level patch** (redact original glyph run, redraw in place, reflow within the line box only) |
| Edit core | **Overlay + deferred bake** — MuPDF reads; edits live in a serializable op log; PDF is written once on export |

### The one business risk to handle early

**MuPDF is AGPL-3.0 by default.** Two things follow that are easy to get wrong:

1. Shipping the WASM binary to a browser is *distribution* — the AGPL reaches your Vue app, not just the WASM.
2. Serving it over a network triggers the AGPL's network clause — you must offer complete corresponding source of the whole app to users.

For a commercial closed-source product this is a launch blocker, not a cleanup task. **Budget the Artifex commercial license before public launch** (phase 8 at the latest; start the conversation around phase 5 since procurement is slow). The alternative — staying AGPL-compliant by open-sourcing the app — is a viable choice, but it needs to be a deliberate one made now rather than discovered later.

---

## 1. Architecture

### 1.1 Repo shape

pnpm monorepo. The justification is specific: `pdf-core` and `edit-model` must run in **both** the browser worker and Node — the browser for real use, Node so exports can be golden-file tested (export a PDF, re-render it to PNG with the same engine, pixel-compare). Without that dual target a single package would be correct.

```
get-margin/
├─ apps/
│  ├─ web/                 # Vue 3 + Vite + Tailwind
│  └─ api/                 # Fastify — does not exist until phase 7
├─ packages/
│  ├─ pdf-core/            # MuPDF facade — framework-free, worker + Node
│  ├─ edit-model/          # op & object types, apply/invert — pure, zero deps
│  └─ shared/              # zod DTOs shared web ↔ api
├─ docs/
└─ pnpm-workspace.yaml
```

#### `apps/web/src`

```
src/
├─ app/
│  ├─ App.vue
│  ├─ layouts/
│  │  ├─ DesktopShell.vue        # ≥1024px: rail + panels
│  │  └─ MobileShell.vue         # <1024px: bottom strip + sheets
│  └─ styles/tokens.css          # Tailwind v4 @theme CSS variables
├─ features/
│  ├─ document/                  # open, load, page list, thumbnails panel
│  ├─ viewport/                  # scroll, zoom, virtualization, render-queue client
│  ├─ tools/                     # one folder per tool (see note below)
│  │  ├─ text/  image/  shape/  freehand/  markup/  whiteout/
│  │  ├─ link/  signature/  form-field/  redact/
│  ├─ inspector/                 # property panels, resolved per object kind
│  ├─ pages/                     # page-ops UI: reorder, rotate, crop, split, merge
│  ├─ export/                    # export dialog, progress, download
│  └─ command-palette/           # ⌘K
├─ overlay/
│  ├─ OverlayRoot.vue
│  ├─ objects/                   # TextObject.vue, ImageObject.vue, ShapeObject.vue, InkObject.vue, …
│  ├─ handles/                   # SelectionBox, ResizeHandles, RotateHandle, SnapGuides
│  └─ interaction/               # useDrag, useMarquee, useSnapping, hitTest
├─ stores/
│  ├─ document.ts                # source metadata, page order, load state
│  ├─ edits.ts                   # objects + op log + undo/redo  ← single source of truth
│  ├─ selection.ts
│  ├─ tool.ts                    # active tool + its sticky defaults
│  └─ viewport.ts                # zoom, scroll anchor, visible page range
├─ workers/
│  ├─ pdf.worker.ts              # Comlink-exposed MuPDF facade
│  └─ pdfClient.ts               # typed proxy + request cancellation
├─ ui/                           # design-system primitives (Button, Popover, Sheet, Slider…)
├─ lib/                          # transform.ts, fonts.ts, color.ts, idb.ts, download.ts
└─ main.ts
```

**`features/tools/*` co-locates each tool's cursor behavior, inspector panel, and op factory in one folder.** Adding a tool touches one directory instead of five. This matters because you're adding ~14 tools.

#### `packages/pdf-core/src`

```
├─ engine.ts        # WASM lifecycle, document handle registry
├─ render.ts        # page → pixmap → ImageBitmap at scale
├─ text.ts          # structured text → normalized TextRun[] (+ stable run addressing)
├─ geometry.ts      # MediaBox/CropBox/Rotate normalization
├─ forms.ts         # widget read + write
├─ annots.ts        # native annotation create/update
├─ fonts.ts         # font registry, metrics, embedding
├─ save.ts          # save options, compression, encryption
└─ write/           # op-log → PDF, one writer per op kind
   ├─ index.ts      # orchestrator: groups ops by page, applies in deterministic order
   ├─ drawText.ts  drawImage.ts  drawShape.ts  whiteout.ts  link.ts
   ├─ markup.ts     # highlight / underline / strikeout as native annots
   ├─ ink.ts  signature.ts  formField.ts
   ├─ pageOps.ts    # rotate, delete, reorder, crop, extract, split, merge
   ├─ watermark.ts  pageNumbers.ts  bates.ts  metadata.ts
   └─ redactText.ts # phase 6 — span-level text patching
```

#### `packages/edit-model/src`

```
├─ objects.ts    # EditObject discriminated union + zod schemas
├─ ops.ts        # Op union
├─ apply.ts      # applyOp(state, op) → { state, patches, inversePatches }
├─ document.ts   # EditDocument type + factory
└─ migrate.ts    # schema versioning for IndexedDB restores
```

Zero runtime deps beyond `immer` and `zod` — it must stay trivially testable.

### 1.2 State model & undo/redo

Edit state is a **single plain serializable object**. No class instances, no DOM refs, no Maps holding live objects. Undo, autosave, crash recovery, and future cloud-save all fall out of that one property.

```ts
EditDocument {
  version: number
  sourceHash: string              // SHA-256 of the original file
  pageOrder: PageId[]
  pages: Record<PageId, PageState>   // { sourceIndex, rotation, cropBox | null }
  objects: Record<ObjectId, EditObject>
  nextZ: number
}

EditObject {
  id: ObjectId
  pageId: PageId
  kind: ObjectKind
  rect: Rect                      // PDF user space, UNROTATED
  rotation: number                // degrees, object's own
  z: number
  locked: boolean
  opacity: number
  ...kindProps                    // discriminated on `kind`
}

ObjectKind =
  | 'text' | 'image' | 'rect' | 'ellipse' | 'line' | 'arrow'
  | 'ink' | 'highlight' | 'underline' | 'strikeout'
  | 'whiteout' | 'link' | 'signature' | 'formField' | 'textPatch'
```

Two invariants do the heavy lifting:

**(a) Every mutation goes through `applyOp(op)`.** Components never assign to store fields. There is exactly one write path, so there is no second path that can desync history. Enforce with a lint rule and by exposing only `applyOp` + getters from the store.

**(b) Objects reference a synthetic `pageId`, never a page index.** Page order lives in a separate `pageOrder` array. Deleting or reordering pages therefore cannot orphan or misattribute objects — the classic bug in this class of app, and one that surfaces as "my signature moved to page 4" long after the code that caused it shipped.

**Undo/redo** uses Immer's `produceWithPatches` inside `applyOp`, which returns forward *and* inverse patches for free — so you never hand-write an `invert()` per op type, which is where these systems normally rot.

```ts
type HistoryEntry = { op: Op; patches: Patch[]; inversePatches: Patch[]; label: string }
// undo: applyPatches(state, entry.inversePatches); past.pop() → future.push()
```

- `withTransaction(label, fn)` coalesces interim ops into one history entry — required for drags, resizes, freehand strokes, and typing (commit on idle ~400ms or on blur). Without this, one drag = 60 undo steps.
- Page-structure ops (delete/reorder/rotate/crop) share the **same linear stack** as object ops, so ⌘Z is globally predictable rather than mode-dependent.
- Cap history at ~200 entries plus a memory ceiling; drop oldest.
- Because geometry is stored in PDF space, **zoom and rotation never enter history** — they're view state in `viewport.ts`.

**Autosave / crash recovery:** debounce 1s → IndexedDB via Dexie, keyed by `sourceHash`. Stores **only the edit log, never the PDF bytes**, so recovery is "restore your edits, re-pick your file." Storing the document itself is an explicit user opt-in. That's a privacy decision expressed as a storage default.

**The cloud-save seam:** `stores/edits` never touches persistence directly. A `DocumentStore` interface (`load(id)`, `save(id, editDocument)`, `list()`) has one implementation now (`IndexedDbStore`) and can gain `ApiStore` later. Because `EditDocument` is already a serializable JSON value with a `version` field and a migration module, adding cloud save is an adapter, not a refactor.

### 1.3 The canvas overlay / editing layer

Three stacked layers per page, sharing one CSS box:

**Layer 1 — `<canvas>`** — the page bitmap from the worker, rasterized at `dpr × zoom` and CSS-downscaled to logical size.

**Layer 2 — `<svg>` with `viewBox="0 0 widthPt heightPt"`** — the load-bearing trick of the whole design. Set the viewBox to the page's PDF dimensions, and put all three of MuPDF's own baked-in page-space transforms — CropBox-origin translation to `(0,0)`, the y-flip, and `/Rotate` (see §1.4) — on a *single root `<g transform>`*. Consequences:

- Every object renders at its **raw stored PDF coordinates with zero per-object math.**
- Zoom is nothing but a CSS width change on the SVG — no re-layout, no recomputation, no re-render of anything.
- Objects are Vue components, so selection state and handles are declarative.
- Output is crisp at any zoom.

**Layer 3 — DOM chrome** — selection box, resize/rotate handles, snap guides, and text editing via an absolutely-positioned `contenteditable`. Kept in DOM rather than SVG specifically so Tailwind, focus management, and IME/mobile virtual keyboards behave normally. SVG text editing is a known misery.

**Plus one transient `<canvas>`** for in-flight freehand: raw pointer stream → `perfect-freehand` → on `pointerup`, commit one `ink` object as an SVG path. Pushing thousands of points into reactive state per stroke is what tanks framerate in naive implementations; this sidesteps it entirely.

**Deliberately not using Fabric.js or Konva.** Both bring their own scene graph and object model that would compete with Pinia for ownership of the truth, forcing bidirectional adapter code. Konva stays the named fallback *if* heavy raster compositing shows up later.

**Virtualization:** only visible pages ±1 mount their overlay. Off-screen pages render the placeholder bitmap only. This is what keeps a 300-page annotated document responsive.

### 1.4 The coordinate contract

One module, `lib/transform.ts`, owns every coordinate conversion:

```ts
pageTransform({ cropBox, rotate, zoom, dpr }) → { toView: DOMMatrix, toPdf: DOMMatrix }
```

- **All stored geometry is unrotated PDF user space** — origin bottom-left, y-up, 72dpi points.
- **MuPDF's own page space — the space `toPixmap()`, `getBounds()`, `getTransform()`, and every `PDFAnnotation` rect/quad setter and getter operate in — already composes three transforms: CropBox-origin translation to `(0,0)`, a top-down y-flip, and `/Rotate`.** `pageTransform` must replicate that exact composition, not just a bare y-flip. Verified: MuPDF's own `getTransform()` matrices for `/Rotate` 0/90/180/270 were checked against this module's math and match exactly, including the CropBox term (`docs/findings/00-engine-facts.md`). Dropping any one of the three — most easily the rotation, since "MuPDF applies rotation" (§1.5) reads like permission to leave it out here — reproduces the exact class of bug this module exists to prevent.
- **This constrains `render.ts` in the opposite direction, not this module.** Because `toPixmap` already applies `/Rotate` internally (§1.5), `render.ts` must pass a scale-only matrix and must not compose rotation into it a second time — that would double-rotate. `transform.ts` still composes all three transforms itself, because it maps *raw, unrotated* PDF-space object geometry onto the same already-rotated page space MuPDF's bitmap uses, so the overlay's `<g transform>` agrees with the pixels underneath. Both statements are true at once.
- Hit-testing goes through `element.getScreenCTM().inverse()` so the browser does the math rather than you.
- **Rule: no component performs its own coordinate arithmetic.** Ever.
- Property-tested across random rects × 4 page rotations × zoom levels × non-zero CropBox origins.

This gets its own module and its own test suite because PDF y-up vs CSS y-down, non-zero CropBox origins, and `/Rotate` are the number one bug source in PDF editors — and the failures are *subtle* (a few points off, only on rotated pages) rather than loud, so they escape manual testing and reach users.

### 1.5 Render pipeline

- **`toPixmap` applies `/Rotate` automatically** — measured: pixmap dimensions swap for 90°/270° pages, and `page.getTransform()`'s returned matrix already contains the rotation (`docs/findings/00-engine-facts.md`). `render.ts` must pass a **scale-only** matrix to `toPixmap`; composing rotation into it as well would double-rotate. This is the mirror image of §1.4's rule, not a contradiction of it: `transform.ts` still must include rotation, because it maps unrotated PDF-space object geometry onto this same already-rotated bitmap.
- **One Comlink-wrapped worker per document**, with a serialized command queue inside (MuPDF is not safely reentrant) and a cancellation token per render request so scrolling away aborts in-flight work.
- `@tanstack/vue-virtual` drives continuous vertical scroll. Render priority = distance from viewport anchor.
- **Two tiers:** one cheap ~0.2× pass over all pages (doubles as the thumbnail panel source), then full-res for visible ±1.
- Bitmaps transfer as `ImageBitmap` from an `OffscreenCanvas` in the worker — zero-copy. Fall back to `ImageData` where unsupported.
- LRU cache keyed `pageId@scale`, capped by total megapixels (~200MP) rather than entry count.
- **Overlay edits never invalidate a page bitmap.** Only source changes — crop, rotate, phase-6 text patch — trigger re-render. This is the concrete payoff of the deferred-bake architecture.

**Disposal is a correctness requirement, not hygiene.** Every `loadPage()` and `toPixmap()` call must be wrapped in `try/finally` calling `.destroy()` unconditionally. Omitting it does not leak gradually — it hard-crashes the WASM heap (`malloc failed`) inside a single few-hundred-page sweep, well within a normal editing session on a 300-page document. Measured: ~5–7MB RSS drift across a 300-page sweep with disposal; +433MB and climbing to a fatal crash without it (`docs/findings/00-engine-facts.md`).

**Pin the single-threaded MuPDF WASM build.** The threaded build needs `SharedArrayBuffer`, which needs COOP/COEP cross-origin isolation headers, which break third-party embeds and complicate hosting — for very little gain given work is already off the main thread.

---

## 2. Feature-by-feature: approach and difficulty

Difficulty is **implementation risk**, not effort: 🟢 straightforward · 🟡 fiddly, plan for it · 🔴 genuinely hard, expect surprises.

### 2.1 Core editing (MVP)

| Feature | Approach | Risk |
|---|---|---|
| Upload (drag-drop + picker) | Native `File` API + `useDropZone` (VueUse). Validate **magic bytes** (`%PDF-`), not extension. `File` → `ArrayBuffer` → worker. Never leaves the browser. | 🟢 |
| Render pages | `Document.openDocument` → `loadPage` → `toPixmap(matrix, colorspace)` → pixels → `ImageBitmap`. See §1.5. | 🟢 |
| Add text | `text` object → SVG `<text>` preview; export writes it. Preview fidelity requires **the same font in the browser as gets embedded** — self-host the font set, load via `FontFace`, measure with canvas `measureText` for the box. | 🟡 |
| Font / size / color | Curated self-hosted set (see §2.5) + the standard 14. Inspector controls. | 🟢 |
| Add images | `PDFDocument.addImage` → XObject drawn on export. Client-side decode/downscale before embedding (a 12MP phone photo dropped on a page must not become a 4MB embed). Handle EXIF orientation. | 🟡 |
| Shapes: rect, ellipse, line, arrow | SVG preview; export as content-stream path operators (or native Square/Circle/Line annots). Arrowheads are computed geometry — a path, not an annotation feature. | 🟢 |
| Hyperlinks | **`page.createLink(bbox, uri)`** — a separate `fz_link` API, not a `PDFAnnotation`. (The originally-specced `createAnnotation('Link')` + `setRect()` does not work: a `Link` annotation rejects `setRect()`/`getRect()`, throwing an ordinary catchable `Error` — an ordinary `try/catch` is sufficient, nothing special needed.) `fz_link` has no `/AP` concept — link hotspots are invisible by design, per the PDF spec — so the overlay must draw its own visual affordance; MuPDF gives no rendered rectangle for free. `getURI()` round-trips exactly. Also detect **existing** links on load so they're editable. Validate/normalize URLs; block `javascript:`. | 🟢 |
| Whiteout | An opaque filled rect above content. **Name it honestly in the UI** — it *covers*, it does not *remove*. The underlying text is still extractable by any PDF tool. For actual removal, that's the phase-6 redact path (§2.4), now backed by a verified mechanism (`applyRedactions()`) that produces genuine, re-extraction-confirmed removal rather than a second cosmetic cover — so the two features can be honestly distinguished in the UI rather than both quietly being covers. Conflating them is a real user-harm risk (people white out SSNs and think they're gone). | 🟡 |
| Highlight / underline / strikeout | Select text via `toStructuredText` quads → native `Highlight`/`Underline`/`StrikeOut` annots with `/QuadPoints`. Native means they stay editable/removable in Acrobat and don't damage the page. **Text selection across a bitmap is its own chunk of work**: build a per-page quad index from structured text and implement selection hit-testing against it. | 🟡 |
| Freehand draw | `perfect-freehand` → transient canvas → commit `ink` object → export as native `Ink` annot (or path). | 🟢 |
| Signature: draw | Same pipeline as freehand, in a modal, on a fixed-aspect pad. | 🟢 |
| Signature: type | Text object with 3–4 self-hosted script fonts. | 🟢 |
| Signature: upload | Image + **background removal** (luminance threshold → alpha) so a phone photo of a signature on paper doesn't paste a white block. Users expect this; without it the feature feels broken. | 🟡 |
| Signature reuse | Store in IndexedDB as a saved asset for reuse within the session and across sessions (explicit opt-in — a signature is sensitive). | 🟢 |
| Rotate page | `pages[pageId].rotation` op; re-render that page. | 🟢 |
| Delete / reorder pages | Ops on `pageOrder`. UI is a drag-sortable thumbnail grid. Objects follow because they're keyed by `pageId` (§1.2b). | 🟢 |
| Crop | Op sets `cropBox`; export applies `setPageBox('CropBox', rect)`. Interactive crop UI + apply-to-all-pages. Note crop **hides**, doesn't delete — same honesty issue as whiteout. | 🟡 |
| Extract / split | Build a new `PDFDocument`, `graftPage` the selected pages. Split by range, by every-N, or by explicit points. | 🟢 |
| Merge | Open N documents, `graftPage` into a target. Needs a multi-document UI (page grid spanning sources) and per-source memory management. | 🟡 |
| Undo/redo | §1.2. Immer inverse patches. | 🟢 |
| Export / download | Op log → `pdf-core/write` → `saveToBuffer('compress,garbage=compact')` → Blob → download. Progress reported from the worker. | 🟡 |

### 2.2 Forms

| Feature | Approach | Risk |
|---|---|---|
| Fill existing fields | `page.getWidgets()` → widget annots with field type/value/options; set via the widget's value setters. This is well-supported and the easy half. | 🟢 |
| Render existing fields | Draw as interactive DOM inputs in Layer 3 positioned over the widget rect — real inputs, so keyboard/mobile/a11y work. | 🟡 |
| Create new fields | `createAnnotation('Widget')` **plus raw PDF object work**: field dict (`/FT`, `/T`, `/Ff` flags, `/Opt` for choices), one-time `/AcroForm` + `/DR` default-resources + `/DA` document wiring, and the `/Fields` array. **Measured, not assumed**: ~9 lines per field once the ~20-line one-time AcroForm/DR wiring exists — text (`/Tx`), checkbox (`/Btn`), and combo (`/Ch`) fields were all built in one document with no dead ends, and mupdf **auto-generates real `/AP` appearance streams for every type**, including two-state checkbox appearances — the fiddly part nobody had to hand-build. Round-trips correctly through save/reload (`page.getWidgets()` on a fresh reopen). Every checkbox/radio field needs an explicit `/MK/BC` border color or its unchecked state renders invisibly (structurally correct, but blank). | 🟡 |
| Field properties | Name, required, read-only, default value, choice options, multiline, max length, appearance. Straightforward once creation works. | 🟢 |
| Tab order | Page `/Annots` array order + `/Tabs /R`. Reorderable list in the inspector. | 🟡 |
| Radio groups | Parent field with kids sharing `/T` and distinct `/AS` on-states. Genuinely fiddly PDF semantics, and **untested by the Phase 0 spike** — structurally inferred to behave like the checkbox case, but not measured. Run a half-day mini-spike at the start of Phase 5 before committing to the phase estimate holding. | 🟡 |

### 2.3 Advanced (phase 6)

| Feature | Approach | Risk |
|---|---|---|
| **Edit existing text** | See §2.4 below — the hardest thing in the product. | 🔴 |
| Find & replace | `toStructuredText` index across all pages → match with normalization (PDFs break words across spans, use ligatures, and have irregular spacing, so naive `indexOf` misses most real matches) → each hit becomes a `textPatch` op. Replace-all is one transaction. | 🔴 |
| Password protect | **Resolved — MuPDF writes genuine encrypted PDFs natively**, no fallback needed: `saveToBuffer('encrypt=aes-256,user-password=<pw>,owner-password=<pw>')`. Confirmed three independent ways: `needsPassword()` on reopen, a real `/Encrypt` dict with `/CFM/AESV3` visible via raw byte inspection, and Apple's CoreGraphics renderer refusing to render the encrypted file while rendering the decrypted twin normally — two of the three checks don't touch MuPDF at all. **Mandatory safety requirement**: an option string with `user-password=`/`owner-password=` but no `encrypt=` key saves cleanly, throws nothing, and produces a completely unprotected PDF — reproduced directly. The implementation must reopen its own output and assert `needsPassword() === true` before reporting success; never treat a non-throwing `saveToBuffer` as evidence of encryption. **New capability, absent from the original plan**: `permissions=<bitmask>` genuinely enforces (verified against an arbitrary bit combination, not just one flag), so the same dialog can legitimately offer print-only / no-copy / no-edit restrictions, not just an open password — worth surfacing in §6's protect dialog as checkboxes. Treat the bitmask semantics as empirically derived, not documented: `permissions=` is not a literal key in the wasm string table. | 🟡 |
| Remove password | `needsPassword()` → `authenticatePassword(pw)` → save without encryption. Only works with the *user* password; can't break encryption, and shouldn't. | 🟢 |
| Watermark | Content-stream draw (text or image) per page, with opacity/rotation/tiling, drawn above or below existing content. | 🟢 |
| Page numbers / header / footer | Same writer, plus token substitution (`{n}`, `{total}`), range selection, margin presets, and skip-first-N. | 🟢 |
| Compression | `saveToBuffer` with `garbage=compact,compress` for structural gains; real wins need **image downsampling/recompression**, which means walking XObjects, re-encoding, and swapping streams. Offer quality presets with a before/after size estimate. | 🟡 |
| Bates numbering | Page-numbers writer + prefix/suffix/start/step/digit-padding, applied across a multi-document set. | 🟢 |
| Metadata editing | Info dict + XMP. Write **both** or viewers disagree about the title. | 🟡 |

### 2.4 The hard one: editing existing text

You chose **line/span-level patch**, which is the right call — paragraph reflow is a multi-week subproject with mediocre results on real-world PDFs, and the failure mode is silently mangling someone's document.

The pipeline:

1. **Extract — two calls, not one.** `page.toStructuredText(options?).asJSON(scale?)` gives blocks → lines, each line **already a homogeneous-style run** with a bbox and font info (name, size, weight/italic flags) — measured: there is **no separate `spans` array** nested under a line, and `asJSON()` itself takes only a numeric `scale`, not an options string (the options string belongs to `toStructuredText()` and affects internal segmentation, not the JSON shape). **Per-character bboxes are not in this output at any option setting.** For those, use `StructuredText.walk({ onChar })` separately — it yields an 8-number quad per character (not an axis-aligned rect, so rotated/skewed runs are representable), needed for precise markup-quad and sub-run-edit geometry. No single call gives both; plan for the two-call shape explicitly. Good news this resolves: per-run font name/size/weight/style are all present, so span-level text editing is confirmed viable, not just assumed.
2. **Address stably** — a patch op must survive reload and replay, so a run is identified by `{pageId, blockIdx, lineIdx, originalTextHash}` (no `spanIdx` — a "span" and a `lines[]` entry are the same thing, per the extraction finding above). The hash is the guard: if extraction shifts (different MuPDF version, different options), the op refuses to apply rather than patching the wrong text. **Fail loudly, never silently mispatch.**
3. **Cover the original glyphs** — the pragmatic approach is drawing an opaque rect in the page background color over the run's bbox, then drawing new text on top. For genuine removal — the redaction feature, where actual removal is the entire point — use **`PDFPage.applyRedactions()`** instead of hand-rolled content-stream surgery. It's a built-in MuPDF primitive, confirmed to remove text verifiably: a fresh cold-reopen re-extraction shows the target text genuinely gone, not merely covered, and it transparently handles FlateDecode-compressed content streams with no manual decode/encode work. **Do not hand-roll a content-stream regex for this** — proven, not merely feared: a naive regex over a `TJ` array containing a literal `]` silently misses the match entirely, exactly the failure mode this document originally speculated about ("a real tokenizer is needed"). Drive `applyRedactions()` with a `Redact` annotation's `/QuadPoints` — it is quad-driven, not `/Rect`-driven — sourced from the same page-space bbox `toStructuredText().asJSON()` already returns for step 1. **Start with cover-and-redraw for ordinary text edits; build the redact feature on `applyRedactions()`.** Caveat: its image/vector-art redaction paths (`image_method`/`line_art_method`) are unexercised — text only was verified — and rotated/skewed quads are untested.
4. **Background color detection** — sample the pixmap around the run's bbox. Works on solid backgrounds, fails on gradients, images, and textures. Detect low confidence (high variance in sampled pixels) and warn the user rather than producing a visible white scar.
5. **Redraw** — reuse the original font if possible. **This is where it genuinely breaks:** embedded fonts in real PDFs are almost always *subsets* containing only the glyphs the document already uses. Type "Ø" into a run whose subset lacks it and there is no glyph to draw. Detect the miss, fall back to a metric-compatible substitute (Liberation family for Arial/Times/Courier metrics), and **tell the user the font was substituted.** Silent substitution that looks slightly wrong is worse than a visible warning.
6. **Fit** — reflow only within the line's bbox. If the new text is wider, offer: shrink to fit / allow overflow / truncate. Never push surrounding content around.

**Set product expectations accordingly.** This works well on single-column, digitally-generated, simple-font documents. It degrades on justified text (per-character positioning), tight kerning, and multi-column layouts, and it does nothing for scanned pages without OCR. Every serious tool including Acrobat has these limits. The UI should communicate confidence per run — e.g. runs that can be cleanly patched get a normal affordance, low-confidence ones get a warning on hover — rather than presenting a uniform illusion of full editability.

**⚠️ Prerequisite before redaction ships as a safety claim, not just a spike finding.** The "text is genuinely gone" result above rests on MuPDF's own write → cold-reopen → re-extract round trip — honest, and arguably the most product-relevant check available since MuPDF *is* the client-side engine, but it is still one engine checking its own output. Before this feature is presented to users as a safety guarantee (as opposed to an internal finding), verify removal with a genuinely independent extractor (`pypdf`, `pdfminer`, `pdftotext`, or Acrobat's own text export — `pdftotext` was unavailable on the spike machine). This matters more than an ordinary verification gap: redaction is the one feature where being wrong has real consequences for a user who redacted something sensitive and was told it worked. **Track this as a release gate on the feature, not on the phase.**

### 2.5 Fonts

A shared concern across text, signatures, watermarks, and text patching, so it gets its own module.

- **Standard 14** always available (no embedding required) — and this is also `FreeText`'s ceiling: **`FreeText` annotation appearance generation only resolves the standard 14 base fonts.** Size, color, family, and `setQuadding(0|1|2)` alignment all work with an auto-generated `/AP`. A custom registered font is **silently ignored** — no `/DR` dictionary gets created to resolve the name, and MuPDF's own `getDefaultAppearance()` reads back `Helv` regardless of what was requested. So `FreeText` is the ~50-line path only when the text tool needs base-14 fonts; a custom/self-hosted font must be drawn as content-stream text operators (the `Font` + `Text` + `Device` primitives — confirmed working end-to-end, including drawing, rendering, and measurement matching to 5 decimal places) or via a hand-built `/DR`, the ~300-line path. §6's font picker should not route custom fonts through the `FreeText` path.
- **Curated self-hosted set**, subsetted and embedded on export: Inter, Roboto, Source Serif, Merriweather, JetBrains Mono, + 3–4 script faces for signatures. Self-hosted (not Google's CDN) so preview and export use byte-identical files and there's no third-party request per document.
- **Metric-compatible substitutes** (Liberation Sans/Serif/Mono) for Arial/Times/Courier fallbacks in text patching.
- **Preview must equal export.** The same font file loads via `FontFace` for the SVG preview and gets embedded on export. Measure with canvas `measureText`.
- **Confirmed: arbitrary TTF embedding works** (`new mupdf.Font(name, bytes)` + `doc.addSimpleFont`/`doc.addFont` on arbitrary TTFs). **But there is no automatic subsetting** — registering a font costs **57–65% of its raw byte size immediately**, measured at two very different scales (a 22.2MB font → ~14.9MB; a 755KB font → ~431KB), the signature of plain Flate compression of the whole font program. `doc.subsetFonts()` exists but made zero measurable difference for a freshly registered, not-yet-drawn font in three configurations. Subsetting matters in practice, not just in theory: embedding a full CJK font this way adds ~10–16MB to every export.
- **DECISION: `pdf-lib` + `@pdf-lib/fontkit` is a runtime dependency**, scoped strictly to font subsetting/embedding for this custom-font path (see §8) — not a fallback, included. MuPDF remains the single engine for rendering, annotations, page composition, and save; this is a narrow carve-out for the one job MuPDF doesn't do automatically, not a second write path.

---

## 3. Data flow: client vs. backend

**Default: everything client-side.** The backend exists only for work that genuinely cannot happen in a browser. This isn't purity — it's what makes the privacy claim true, keeps hosting costs near zero for the common path, and removes upload latency from every interaction.

### Client-side only (no network, ever)

Open · render · all annotation and object editing · undo/redo · text extraction and selection · page ops (rotate/delete/reorder/crop/extract/split/merge) · form fill and form-field creation · watermark · page numbers · Bates · metadata · find & replace · text patching · compression · export/download · PDF → JPG · autosave to IndexedDB.

That's the entire MVP plus most of phase 6. **The MVP ships with no backend at all.**

### Requires a backend round-trip

| Operation | Why it can't be client-side |
|---|---|
| PDF → Word/Excel/PowerPoint | Needs LibreOffice — a ~1GB native binary. No browser path. |
| Word/Excel/PowerPoint → PDF | Same. |
| OCR (scanned docs) | Tesseract WASM exists, but a 50-page scan takes minutes on a phone and needs ~100MB of language data. Server-side with a real binary is 10–50× faster. Offer client-side WASM as a fallback for single pages / offline. |
| HTML → PDF | Needs a real browser engine (Playwright). Can't nest a browser in a browser. |
| Very large documents | Optional escape hatch: if a doc exceeds the client budget (~150MB / ~800 pages), offer server-side processing with an explicit consent prompt. |

**Encryption's backend fallback never materializes.** This table originally had a conditional "Encryption (fallback only)" row here; Phase 0 confirmed MuPDF writes genuine AES-256 encrypted PDFs client-side (§2.3), so that row is removed rather than kept as a dead conditional.

### Round-trip shape

Conversions are **stateless async jobs**, not request/response — LibreOffice cold-starts in seconds and OCR takes minutes, so a synchronous HTTP call would time out and block a worker.

```
POST /v1/jobs (multipart)  → { jobId, statusUrl }   # file → temp storage, job → queue
GET  /v1/jobs/:id          → { status, progress, resultUrl? }   # SSE or poll
GET  /v1/jobs/:id/result   → the file; deleted immediately after first successful read
DELETE /v1/jobs/:id        → client-initiated purge (offer this in the UI)
```

Job types: `pdf-to-docx`, `pdf-to-xlsx`, `pdf-to-pptx`, `office-to-pdf`, `ocr`, `html-to-pdf`.

`packages/shared` holds the zod schemas for these DTOs so client and server can't drift.

---

## 4. File handling, security, privacy

### Client-side

- Files never leave the browser except for the §3 operations, and those require an **explicit per-action consent step** that names what's being uploaded and when it's deleted. No silent uploads.
- Validate magic bytes, not filename extension.
- Enforce a soft cap (~150MB / ~800 pages) with a clear warning rather than an OOM crash. Track worker memory and degrade the bitmap cache under pressure.
- IndexedDB holds the **edit log only** by default, never document bytes. Saved signatures are opt-in. A visible "clear local data" control, and clear-on-demand for saved signatures.
- Encrypted-PDF passwords live in memory only — never in IndexedDB, never in a store that gets serialized.

### Server-side (phase 7)

- **Temp storage only.** Random 32-byte job ID as the directory name (unguessable — no enumeration). Local disk for a single node; S3-compatible object storage with lifecycle rules if you scale out.
- **TTL 1 hour**, plus delete-on-successful-download, plus a sweeper cron for orphans. Deletion is unconditional and not contingent on the job succeeding.
- **Never log filenames, file contents, or job payloads.** Log job type, byte size, duration, outcome. This has to be a deliberate pino redaction config, because the default is to log whatever you hand it.
- **Sandbox the converters — this is the real security surface.** LibreOffice, Tesseract, and Ghostscript are large C++ codebases parsing untrusted, attacker-controlled input, and they have a long history of RCE CVEs. Anyone can upload anything. Therefore: converters run in a **separate container from the API**, with no network egress, a read-only root filesystem except the job tmpdir, a non-root user, dropped capabilities, a seccomp profile, hard memory/CPU limits, and a wall-clock timeout that kills the process group (LibreOffice hangs on malformed input — reliably, not rarely).
- Sanitize `Content-Disposition` filenames on the way out; never echo a user-supplied path.
- Rate limit per IP and per job type (`@fastify/rate-limit`). Conversion is expensive; without limits it's a free CPU faucet.
- `@fastify/helmet` for headers; strict CSP on the frontend (`wasm-unsafe-eval` is needed for the WASM, nothing broader).
- **PDF-embedded JavaScript is never executed.** MuPDF doesn't run it by default — keep it that way, and strip `/JS`, `/OpenAction`, and `/Launch` actions on export as a hardening pass.
- A plain-language privacy page stating exactly what is and isn't uploaded. It's a competitive advantage here; make it specific rather than boilerplate.

---

## 5. Backend design (phase 7)

**Fastify over Hono.** Hono is excellent and lighter, but you need battle-tested multipart streaming of large files, rate limiting, and a mature plugin ecosystem — that's Fastify's strength. Hono's edge-runtime advantage is irrelevant when the workload requires a fat container with LibreOffice in it.

```
apps/api/src/
├─ server.ts                # Fastify bootstrap, plugins, graceful shutdown
├─ routes/jobs.ts           # POST /jobs, GET /jobs/:id, result, DELETE
├─ jobs/
│  ├─ queue.ts              # BullMQ producer
│  └─ types.ts              # shared with packages/shared via zod
├─ storage/
│  ├─ local.ts  s3.ts       # StorageAdapter interface
│  └─ sweeper.ts            # TTL cron
└─ plugins/                 # helmet, rate-limit, multipart, pino redaction

apps/worker/src/            # separate container, separate deploy
├─ index.ts                 # BullMQ consumer
├─ converters/
│  ├─ office.ts             # unoserver client
│  ├─ ocr.ts                # ocrmypdf
│  └─ html.ts               # Playwright
└─ sandbox.ts               # execa + timeouts + process-group kill
```

**API and worker are separate containers.** The API is small and public; the worker is fat, sandboxed, and network-isolated. Coupling them would put a public HTTP surface in the same blast radius as the untrusted-file parsers.

**LibreOffice via `unoserver`,** not raw `soffice --convert-to` per request. Raw invocation cold-starts 2–4 seconds *per conversion* and LibreOffice corrupts state when concurrent processes share a user profile. `unoserver` keeps a warm LO daemon with a proper request queue. Run one daemon per worker container with an isolated `-env:UserInstallation`, and scale by adding containers.

**OCR via `ocrmypdf`,** not raw Tesseract. Tesseract gives you text and bounding boxes; turning that into a correctly positioned invisible text layer over the original page image — with deskew, rotation detection, and without degrading the scan — is exactly what `ocrmypdf` does well and what's tedious and bug-prone to hand-roll. Cost: it's Python, so the worker image needs Python + Ghostscript. Worth it.

**Be honest about PDF → Office quality.** PDF has no notion of paragraphs, tables, or styles — those must be *inferred*. LibreOffice's PDF import goes through Draw and produces Word files that are technically valid but structurally poor (text boxes rather than flowing paragraphs). Every tool on the market including Sejda and Acrobat is imperfect here; Acrobat is best because Adobe spent years on layout inference. Plan: ship LibreOffice, measure against real documents, and if quality is unacceptable, evaluate a commercial SDK or a structured-text → `docx` pipeline for the text-heavy case. **Do not promise fidelity you can't deliver** — this is the single most common source of refund requests in this product category.

---

## 6. UI/UX direction

Modern SaaS tool aesthetic — Linear/Figma register: quiet chrome, content-forward, dense but not cramped, fast and physical. **Original design; no structural or visual reference to Sejda.** The point of the layout below is that chrome recedes and the document dominates.

### Desktop (≥1024px)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ◈ get-margin   contract-v3.pdf ·          ⟲ ⟳    │  ⤓ Download      ⚙ │  56px
├────┬─────────────────────────────────────────────────────┬───────────────┤
│    │                                                     │               │
│ ▣  │        ┌───────────────────────────────┐            │  Text         │
│ T  │        │                               │            │  ─────────    │
│ ▭  │        │                               │            │  Font  [Inter]│
│ ✎  │        │           page 1              │            │  Size  [ 12 ] │
│ ⬒  │        │                               │            │  Color ███    │
│ ✍  │        │                               │            │  Align ▤▥▦    │
│ 🔗 │        └───────────────────────────────┘            │               │
│ ▦  │                                                     │  Position     │
│    │        ┌───────────────────────────────┐            │  X 120  Y 340 │
│ ── │        │           page 2              │            │  W 200  H  18 │
│ ⬚  │        │                               │            │               │
│    │                                                     │  Opacity ──○─ │
│    │                          ╭─────────────╮            │               │
│    │                          │ 84%  ─ ⊕ ⛶ │            │               │
└────┴──────────────────────────╰─────────────╯────────────┴───────────────┘
  64px          neutral workspace, elevated page sheets          320px
```

- **Top bar, 56px.** Wordmark · filename (inline-editable, with a subtle unsaved-changes dot) · undo/redo · zoom readout. Right: one primary **Download** button (the only filled accent element on screen — a single visual climax is what makes an interface feel designed) plus a settings menu. No menu bar; ⌘K covers the long tail.
- **Left rail, 64px.** Vertical icon tools in semantic groups separated by hairlines: select · text · shapes/image · draw · markup · sign · link · form. Active tool gets a filled accent square with a soft ring. Tooltips on hover show name + shortcut. A rail rather than a horizontal ribbon because vertical space is what a portrait document needs least.
- **Pages panel**, toggled from the rail, slides in at 240px: drag-sortable thumbnail grid with multi-select, per-page rotate/delete on hover, and the page-ops entry points.
- **Center workspace.** Neutral `zinc-100` / `zinc-900` ground; pages as white sheets with `rounded-lg`, a hairline ring, and a soft shadow. Continuous vertical scroll, centered, generous gutters.
- **Right inspector, 320px, collapsible.** Contextual to selection. Empty state shows document info (pages, dimensions, file size, producer) rather than going blank — dead panels read as broken.
- **Floating selection toolbar** above the selected object (Figma/Notion register) carrying the 3–4 most-used properties for that kind. This is what makes editing feel fast: the common case shouldn't require crossing the screen to the inspector.
- **Floating zoom pill**, bottom-right: percentage, −/+, fit-width, fit-page, actual-size.
- **⌘K command palette.** Cheap to build, disproportionate signal of tool quality, and the honest answer to "where's the menu for X."

### Mobile (<1024px) — a distinct shell, one shared state layer

Full responsiveness down to phone was chosen deliberately; it is real additional work (~2 weeks spread across phases 1, 2, and 4), and the way to keep it from doubling the UI is that **only the shell differs.** `DesktopShell.vue` and `MobileShell.vue` compose the same feature components and read the same stores. Tool logic, overlay, and inspector panels are shared; layout and gesture handling are not.

```
┌─────────────────────────┐
│ ‹  contract-v3.pdf   ⤓  │   compact bar
├─────────────────────────┤
│                         │
│   ┌─────────────────┐   │   pinch-zoom + pan
│   │                 │   │
│   │     page 1      │   │
│   │                 │   │
│   └─────────────────┘   │
│                         │
├─────────────────────────┤
│  ╭───────────────────╮  │   drag-up bottom sheet
│  │ ▁▁▁               │  │   (properties of selection)
│  │  Text             │  │
│  │  Inter    12   ███│  │
├──┴───────────────────┴──┤
│ ▣  T  ▭  ✎  ⬒  ✍  🔗  ▦ │   scrollable tool strip
└─────────────────────────┘
```

- **Bottom sheet** for properties, snapping at peek/half/full — thumb-reachable, unlike a top or side panel.
- **Scrollable bottom tool strip** with 44px minimum touch targets.
- **Pages panel becomes a full-screen modal.**
- **Gestures:** pinch-zoom, two-finger pan, single-finger draw when a draw tool is active. Use the **Pointer Events API** throughout so mouse/touch/pen share one code path rather than three.
- **Palm rejection** for freehand/signature: ignore contacts above a size threshold, prefer `pointerType === 'pen'` when present.
- Selection handles enlarge on touch; drag targets get invisible padding.

### Design tokens

- **Tailwind v4** with `@theme` CSS variables so tokens are inspectable at runtime and themeable without a rebuild.
- **Neutral-forward palette:** `zinc` scale carries ~95% of the UI. One accent (indigo-600 light / indigo-500 dark). Semantic tokens only — `--color-surface`, `--color-border`, `--color-text-muted` — never raw palette values in components, so dark mode is a token swap rather than a `dark:` audit.
- **Type:** Inter variable (or Geist). Tight tracking on headings, `text-[13px]` for panel labels — dense-but-legible is the register.
- **Spacing:** 4px base, 8px rhythm. **Radius:** 6px controls / 10px panels / 12px sheets. **Shadows:** two levels only, both soft and low-opacity. Borders are hairlines at low-alpha, not `gray-300`.
- **Motion:** 120–180ms `ease-out` for state changes; spring only for sheets and the panel slide. Respect `prefers-reduced-motion`. No animation on anything in a drag loop.
- **Icons:** `lucide-vue-next`, single 1.5px stroke weight throughout. Mixed stroke weights are the fastest way to look amateur.
- **Dark mode from day one**, via `data-theme` on `<html>` plus system default. Retrofitting it is painful; tokens make it nearly free up front.
- **Explicitly avoid:** gradients, glassmorphism, colorful multi-hue icons, heavy borders, drop shadows on text, more than one accent color.
- **Accessibility as a constraint, not a phase:** keyboard-reachable tools, visible focus rings, ARIA on the overlay, 4.5:1 contrast minimum, screen-reader labels on canvas objects. Build on `reka-ui` primitives so dialogs/menus/sliders get focus trapping and roles correctly for free.

---

## 7. Roadmap

Solo, full-time, AI-assisted. Weeks are calendar weeks and **include** the responsive-shell work.

### Phase 0 — De-risking spikes · 4 days

**Complete.** Full decision record: `docs/findings/00-phase-0-decisions.md`. Every item below resolved; the two items still open (radio-group semantics, Acrobat/Chrome human verification) are tracked there, not here.

Throwaway code, written to answer questions. **Do this before building anything on top of assumptions.** Verify in mupdf.js specifically:

1. Render throughput — a 300-page document, time to first page and steady-state page rate.
2. `toStructuredText` output shape: spans, per-char bboxes, font names/flags. Is it good enough to address text runs stably?
3. `createAnnotation` for Highlight/Ink/FreeText/Link — does MuPDF generate acceptable appearance streams?
4. **Arbitrary TTF embedding** via `addSimpleFont`. → decides whether `pdf-lib` enters the font path.
5. **Save with encryption** through `saveToBuffer` options. → decides whether `qpdf-wasm` is needed.
6. **Widget/form-field creation** via raw `PDFObject` work. → sizes phase 5.
7. Content-stream read/modify/write round-trip. → sizes phase 6's redaction.

Also stand up: Comlink worker harness, `lib/transform.ts` + its property tests, and the golden-file test rig (export → re-render in Node → pixel-compare). **Build the test rig before the features it protects.**

> Deliverable: a written findings note. Any 🔴 result reshapes the phases below — better to learn it now.

### Phase 1 — Viewer shell · weeks 1–2.5

Monorepo scaffold · design tokens + `ui/` primitives · both shells · upload/validation · worker render pipeline · virtualized scroll · zoom/fit · thumbnails panel · dark mode · empty/loading/error states.

> **Milestone: open any PDF and read it comfortably on desktop and phone.**

### Phase 2 — Edit core · weeks 2.5–6

**Built.** Implementation plan: `PLAN-PHASE-2.md` (Tasks 22–40). Verification record:
`docs/findings/06-phase-2-verification.md`. Export performance:
`docs/findings/05-export-performance.md`.

Edit store + `applyOp` + Immer undo/redo · SVG overlay + selection/transform handles + snapping · text · image · shapes · whiteout · links · freehand · text-quad index and selection · highlight/underline/strikeout · signature (draw/type/upload + background removal) · inspector panels · floating selection toolbar · **export pipeline v1** + golden tests.

> **Milestone: annotate and sign a document, download it, and open it correctly in Acrobat, Preview, and Chrome.** Verify in all three — they disagree, and Preview is the most forgiving, so it will lie to you.

**The milestone is NOT met yet.** Everything above the last clause is done and covered by goldens
on unrotated, offset-CropBox, and quarter-turned pages; the Acrobat/Preview/Chrome half is
**outstanding**, for the same reason Phase 0 left it outstanding — no GUI in the build
environment. Sample files to open are in `docs/findings/evidence/phase-2-*.pdf` and the matrix to
fill in is in the verification record. Two smaller items are deferred and recorded there:
**snapping** (moved to Phase 4 by `PHASE-2-DESIGN.md` §0) and **adopting a document's existing
links** into the edit store (Task 34 Step 5).

### Phase 3 — Page operations · weeks 6–7

**Built.** Design: `PHASE-3-DESIGN.md`. Plan: `PLAN-PHASE-3.md` (Tasks 41–51). Pre-flight
measurements: `docs/findings/07-phase-3-preflight.md`. Verification record:
`docs/findings/08-phase-3-verification.md`.

Rotate · delete · reorder · crop UI · extract · split · merge (multi-document open) · pages-panel interactions.

Page order and per-page rotation/crop moved into `EditDocument` (schema v2), so page operations
share the object ops' single undo stack and ⌘Z is globally predictable. The write path grew three
assembly tiers: byte-identical pass-through, lossless in-place restructuring for one source, and
graft **plus an explicit `/Annots` graft** for merge — without that last step every merge silently
destroys the annotations already in the user's file.

**Outstanding**, recorded in the verification file rather than implied complete: cross-viewer
checks in Acrobat/Preview/Chrome (no GUI available, as in Phase 2), and bookmarks/page labels are
lost across a merge, which the UI states. The phone-only gap this phase left — page selection, and
so rotate and delete, reachable on desktop only — was closed by Phase 4's Task 64.

### Phase 4 — MVP hardening · weeks 7–9

**Built.** Design: `PHASE-4-DESIGN.md`. Plan: `PLAN-PHASE-4.md` (Tasks 52–65). Pre-flight
measurements: `docs/findings/09-phase-4-preflight.md` and `10-large-document-performance.md`.
Verification record: `docs/findings/11-phase-4-verification.md`.

IndexedDB autosave + crash recovery · keyboard shortcuts · ⌘K palette · a11y pass · mobile gesture polish (pinch/pan/palm rejection) · perf pass on a 300-page document · memory-pressure handling · error boundaries · `/JS` + `/OpenAction` stripping · privacy page · onboarding empty state.

Two decisions worth carrying forward. Active content is stripped **before** the byte-identical
pass-through is considered, so an unedited hostile file cannot be handed back with its scripts
intact — and because stripping is a change, such a file leaves the pass-through tier. And recovery
is *offered*, never automatic: silently restoring an old draft over the file someone just opened is
data loss wearing a helpful face.

**Outstanding**, recorded in the verification file: the cross-viewer checks accumulated since
Phase 2, and a run on real phone hardware. Both are gating — see below.

> ### ▶ **Shippable MVP — end of week 9**
> Ships as a pure static frontend. **No backend, no database, no accounts, no per-user hosting cost.**
>
> **Feature-complete; not yet verified.** Everything above is built and covered by tests that run on
> every commit. But this tool's whole promise is *your files never leave your device and the file
> you get back opens correctly everywhere*, and no agent here has a GUI or a phone: no export has
> been opened in Acrobat, and no gesture has met a real finger. Those two checks are the gate.
> Until someone runs them, this is a release candidate.

### Phase 5 — Forms · weeks 9–12

Fill existing fields (interactive DOM widgets) · create fields (text, multiline, dropdown, checkbox, radio, signature box) · properties panel · tab-order editor · AcroForm setup · flatten-form-on-export option.

> **Confirmed at 3 weeks by the Phase 0 spike** (`docs/findings/04-raw-objects.md`) — field creation measured at ~9 lines/field plus ~20 lines of one-time AcroForm/DR wiring, with mupdf auto-generating `/AP` appearance streams (including two-state checkboxes) for free, so the estimate holds rather than needing the +1 week hedge the plan originally carried. Two things still gate calling this phase *done*, not just week 12: a half-day radio-group mini-spike at the start of the phase (untested parent/kid `/T`+`/AS` semantics), and human verification that the created fields are actually interactive in Acrobat and Chrome.

### Phase 6 — Advanced document ops · weeks 12–15

**Text patching (~1 week of this, revised down from ~1.5 — see §2.4)** · find & replace · watermark · page numbers/header/footer · Bates · metadata (Info + XMP) · compression with presets · password protect/remove · true redaction (via `PDFPage.applyRedactions()`, not hand-rolled content-stream surgery — see §2.4; the Phase 0 spike proved a naive regex path unreliable and found MuPDF's own primitive instead).

> Highest-variance phase in the plan. Ship the rest of phase 6 first so text editing can slip without blocking the release. Redaction is a release gate on the feature (independent-extractor verification, §2.4), not on this phase's calendar slot.

### Phase 7 — Conversion backend · weeks 15–19

Fastify service · BullMQ + Redis · storage adapter + TTL sweeper · separate sandboxed worker container · `unoserver` · `ocrmypdf` · Playwright HTML→PDF · PDF→JPG (client-side, MuPDF) · job UI with progress · rate limiting · consent flows · Docker images · CI.

> First phase with real infrastructure cost and real attack surface. Do the sandboxing in this phase, not after.

### Phase 8 — Polish & launch · weeks 19–21.5

Cross-browser matrix · real-device testing · **Artifex commercial license finalized** · load testing on the worker tier · error monitoring · analytics (privacy-respecting) · docs/help · marketing site · pricing/limits if applicable.

### Summary

| | |
|---|---|
| **MVP (core editing)** | ~9 weeks |
| **+ Forms** | ~12 weeks |
| **+ Advanced** | ~15 weeks |
| **+ Conversion** | ~19 weeks |
| **Full parity, launch-ready** | **~21.5 weeks** |

Phase 6's estimate moved down by 0.5 week (text patching's `applyRedactions()`-based approach vs. the originally-planned hand-rolled surgery, §2.4); every phase after it shifts down by the same 0.5 week accordingly.

**The three schedule risks, honestly:** (1) existing-text editing quality on real-world documents; (2) PDF→Office fidelity, which is industry-wide unsolved; (3) form-field creation, flagged as a risk *if* mupdf.js's raw-object ergonomics turned out poor. **Phase 0 resolved (3) favorably** — ergonomics were good, no dead ends, and the Phase 5 estimate holds unchanged (see above) rather than needing the +1 week hedge originally carried for it. (1) and (2) remain quality risks more than schedule risks — they'll ship, the question is how good they are.

---

## 8. Package list

### Frontend

| Package | Why |
|---|---|
| `mupdf` | Official Artifex mupdf.js. Prefer over the community `mupdf-js` wrapper. |
| `pinia` | State. |
| `immer` | `produceWithPatches` → free inverse patches → undo/redo. Load-bearing. |
| `comlink` | Worker RPC. Turns postMessage plumbing into typed async calls; large ergonomics win. |
| `@vueuse/core` | `useDropZone`, `usePointer`, `useResizeObserver`, `useMagicKeys`, `useIntersectionObserver`. |
| `@tanstack/vue-virtual` | Page virtualization. |
| `perfect-freehand` | Pressure-sensitive stroke smoothing for draw + signature. |
| `reka-ui` | Accessible headless primitives (radix-vue's successor): dialog, popover, dropdown, slider, tabs, tooltip. Focus trapping and ARIA for free. |
| `@floating-ui/vue` | Positioning for the floating selection toolbar and tooltips. |
| `lucide-vue-next` | Icons, uniform stroke weight. |
| `tailwind-merge` + `class-variance-authority` | Variant-based component API without class soup. |
| `dexie` | IndexedDB — autosave, saved signatures. |
| `zod` | Runtime validation; shared schemas with the API. |
| `nanoid` | Object/page IDs. |
| `colord` | Color parsing/conversion for the picker. |
| `fflate` | Zip for multi-file downloads (split output, PDF→JPG). |
| `vue-sonner` | Toasts. |
| `pdf-lib` + `@pdf-lib/fontkit` | **Included, not conditional** — MuPDF embeds whole font programs with no automatic subsetting (measured: 57–65% of raw TTF bytes on registration, `subsetFonts()` makes no measurable difference); `pdf-lib`/`fontkit` handle subsetting/embedding, scoped strictly to that path (§2.5, §8 test tooling note below). MuPDF stays the single engine for everything else. |

Not included, deliberately: **`pdfjs-dist`** — MuPDF covers rendering; a second engine means two renderers to keep visually consistent. **`fabric` / `konva`** — see §1.3. **`qpdf-wasm`** — resolved out at Phase 0: MuPDF's own `saveToBuffer('encrypt=aes-256,...')` writes genuine AES-256 encrypted PDFs natively (§2.3), verified three independent ways, so no second WASM binary or lazy-chunk strategy is needed for encryption.

### Backend

`fastify` · `@fastify/multipart` `@fastify/rate-limit` `@fastify/helmet` `@fastify/cors` · `bullmq` + `ioredis` · `pino` (with redaction configured) · `execa` (process control + timeouts) · `tmp-promise` · `playwright` · `zod` · `@aws-sdk/client-s3` (only when scaling past one node).

Native/system: LibreOffice + `unoserver` (Python) · Tesseract + `ocrmypdf` (Python) · Ghostscript · `qpdf` · font packages (DejaVu, Liberation, Noto CJK).

### Testing

`vitest` · `@vue/test-utils` · `@playwright/test` (e2e) · `fast-check` (property tests for the transform module) · `pngjs` + `pixelmatch` (golden-file image comparison) · `pdf-lib` and `tsx` as devDependencies for deterministic fixture generation. (`pdf-lib` appears twice in this document for two unrelated reasons: here as a Node devDependency for building test fixtures, and in Frontend above as a runtime dependency for font subsetting — same package, different jobs.)

**The golden-file rig is the most valuable test asset in this project.** Because MuPDF runs in Node, you can: fixture PDF + op log → export → render exported pages to PNG → pixel-compare against goldens. This is the only mechanism that catches overlay-preview drifting from baked output, which is the central risk of the deferred-bake architecture. Build it in phase 0.

---

## 9. Deployment

### Frontend

- **Static build on a CDN** — Cloudflare Pages, Netlify, or Vercel. There's no SSR requirement; SSR would only add a server to a client-side app.
- **Self-host the WASM binary. Do not use a CDN for it.** Reasons: (a) version pinning — a silent upstream bump changes render output and breaks your goldens; (b) integrity — third-party WASM is arbitrary code execution in your users' browsers; (c) a strict CSP without third-party `wasm-unsafe-eval` origins; (d) offline/PWA capability; (e) no third-party availability dependency for your core function.
- Serve the WASM with `Content-Type: application/wasm` (enables streaming compilation), `Cache-Control: immutable` on a hashed filename, and Brotli — the binary is ~10–15MB raw and compresses well.
- Load it **lazily**, after first paint, with a progress indicator. Do not block the shell on a 15MB fetch; show the UI, then enable the drop zone.
- **Single-threaded WASM build** — avoids COOP/COEP cross-origin isolation entirely (§1.5).
- CSP: `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self' blob:`, no third-party origins.
- Frontend and backend on separate origins with explicit CORS, so the fat backend can't be reached from anywhere you didn't intend.

### Backend

- **Not serverless.** The worker image with LibreOffice + Tesseract + Ghostscript + fonts is ~1.5–2GB. That exceeds Lambda's image limits in practice, cold-starts terribly, and LibreOffice wants a warm long-lived daemon — the opposite of the serverless model.
- **Two container services:**
  - **API** — small Node image, scales horizontally, public. Fly.io / Railway / Render / a plain VPS with Docker Compose all work. Start with the cheapest thing that runs a container.
  - **Worker** — fat image, sandboxed, **no public ingress, no network egress**, memory-limited (LibreOffice on a malformed file will happily eat all available RAM), CPU-limited, with a wall-clock kill. Scale by replica count driven by queue depth.
- **Redis** for BullMQ — managed (Upstash/Fly Redis) is fine and cheap.
- **Storage:** local volume for a single worker; S3-compatible with lifecycle expiry once there's more than one, because job files must be readable by whichever worker picks up the job.
- Start with a **single small VPS running Docker Compose** (API + worker + Redis). This is genuinely sufficient for early traffic, costs ~$20–40/month, and you can move to managed services when queue depth justifies it. Don't build for scale you don't have — but *do* build the container split now, because retrofitting the sandbox boundary later means re-architecting under pressure.
- Observability: Sentry (frontend + backend), queue depth / job duration / failure rate metrics, uptime checks. Zero payload logging.

### Cost shape

The MVP is a static site: effectively free, and it scales to any traffic level without touching a server. Cost only appears in phase 7, and it's CPU-bound conversion work — which is a strong argument for keeping conversions behind an account or usage limit if you ever monetize, since a public unlimited conversion endpoint is a bill someone else controls.

---

## 10. Open questions to resolve before phase 1

1. **Phase 0 spike results — RESOLVED.** Full record: `docs/findings/00-phase-0-decisions.md`. `pdf-lib` is in, `qpdf-wasm` is out, form-field creation downgraded from 🔴 to 🟡 with the Phase 5 estimate confirmed. What's still genuinely open, and must not be treated as settled: a half-day radio-group mini-spike at the start of Phase 5, and human verification of native annotations/widgets/encrypted PDFs in Acrobat and Chrome — Phase 0 only had MuPDF and Apple's CoreGraphics renderer available in this environment.
2. **AGPL vs. commercial license** — start the Artifex conversation by phase 5. It gates launch, not development.
3. **Client-side size cap** — I've assumed ~150MB / ~800 pages. Worth validating against your expected documents on a mid-range phone, since you've committed to phone support.
4. **PDF→Office quality bar** — decide what's acceptable after measuring LibreOffice against real documents in phase 7, before promising anything publicly.
5. **Scope of "fill & sign" as a separate flow** — Sejda has a distinct simplified signing mode. Worth considering as its own streamlined entry point later; it's the highest-traffic use case for this category of tool and benefits from a UI that hides everything else.
