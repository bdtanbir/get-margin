# Phase 2 — Edit Core: Design

**Status:** design, awaiting approval. The executable task breakdown lands separately in `PLAN-PHASE-2.md`.

**Milestone (PLAN.md §7):** annotate and sign a document, download it, and open it correctly in Acrobat, Preview, and Chrome.

**Predecessor:** Phase 1 complete and merged (`c6cd91a`) — 196 passing tests, clean `tsc` and `vue-tsc`. The viewer opens, renders, scrolls, zooms, and thumbnails any PDF. Nothing in Phase 1 is being reworked.

---

## 0. Decisions taken in this design round

These four were open when Phase 2 started. They are settled now and the rest of this document assumes them.

| Decision | Choice | Why |
|---|---|---|
| **Build order** | Export spine first | Export is the riskiest piece (🟡 in §2.1) and it is the piece the user actually noticed missing. Building it first means every tool ships with a passing golden export test *the day it lands* rather than discovering a systemic export problem at the end, with every tool already written against it. |
| **Export representation** | Semantic split | Native annotations for things that *are* annotations (highlight, underline, strikeout, ink) so they stay editable and removable in other PDF tools. Content-stream drawing for things the user *places* (text, shapes, arrows, image, whiteout, signature). Links via `page.createLink`. `FreeText` is not used at all. |
| **Export source** | Retain pristine bytes in worker | Export is a pure function of `(sourceBytes, EditDocument)`. Fully testable in Node with no browser, and an unedited Download returns the user's exact original file. |
| **Scope trims** | Font subsetting → Phase 4 · Snapping/alignment guides → Phase 4 | Subsetting is a size optimisation, not a capability, and keeping `pdf-lib` out of the export path while that path is still being proven is worth ~180KB/document. Snapping needs real usage to tune thresholds against. |

### Why `FreeText` is dropped entirely

Phase 0 measured (`docs/findings/02-write-path.md` Q3) that `FreeText` silently ignores any font outside the standard 14: registering Zapfino and calling `setDefaultAppearance('Zapfino', 20, …)` wrote the literal string `/Zapfino 20 Tf 0 0 0 rg` into `/DA`, created **no `/DR`** to resolve the name, and MuPDF's own `getDefaultAppearance()` read back `Helv`.

PLAN.md §2.5 commits to a curated self-hosted set — Inter, Roboto, Source Serif, Merriweather, JetBrains Mono, plus script faces for signatures. **None of those are base-14.** So the text tool's *default* font already falls off `FreeText`'s cliff. Maintaining `FreeText` as a second text implementation, reachable only by a fallback nobody selects, is pure cost. One text path, drawn as content-stream operators.

---

## 1. Architecture

Phase 2 adds three things to the Phase 1 app, and changes nothing that already exists except by extension.

```
  ┌─────────────────────────────────────────────────────────┐
  │ main thread                                             │
  │                                                         │
  │   stores/edits.ts    ← NEW. EditDocument + applyOp +     │
  │        │               Immer history. The only writer.   │
  │        ▼                                                 │
  │   features/overlay/  ← NEW. SVG object layer + DOM       │
  │        │               chrome (selection, handles).      │
  │        │                                                 │
  │   stores/document.ts   stores/viewport.ts   (unchanged)  │
  └────────┬────────────────────────────────────────────────┘
           │ Comlink
  ┌────────▼────────────────────────────────────────────────┐
  │ worker                                                   │
  │   PdfService  .open .authenticate .render .close          │
  │               .save(editDocument)   ← NEW                 │
  │               #sourceBytes          ← NEW (pristine)      │
  │                    │                                      │
  │   pdf-core/write/  ← NEW. replay(sourceBytes, editDoc)    │
  └──────────────────────────────────────────────────────────┘
```

**The deferred-bake invariant (§1.5) is what makes this cheap.** The viewing `PdfDocument` is never mutated. Editing produces state, not PDF bytes. A page bitmap is invalidated only by a *source* change — and Phase 2 has none (crop and rotate are Phase 3). So the entire editing experience runs without a single re-render.

### 1.1 New files

```
packages/pdf-core/src/write/
  index.ts          replay(sourceBytes, editDoc, opts) -> Uint8Array
  session.ts        open/dispose lifecycle; try/finally .destroy() discipline
  content.ts        content-stream drawing primitives (path, text, image)
  annots.ts         native annotation writers (highlight/underline/strikeout/ink)
  links.ts          page.createLink + URL validation
  coords.ts         the two coordinate conventions (see §3) — single owner
  objects/          one writer per ObjectKind, each ~30-60 lines. These hold
    text.ts  image.ts  shape.ts  whiteout.ts  signature.ts   the per-kind rules
    ink.ts   markup.ts link.ts                               and call the
                      primitives above; they never touch MuPDF directly (§2).

packages/pdf-core/src/text/
  index.ts          buildQuadIndex(doc, pageIndex) -> PageQuadIndex

apps/web/src/stores/
  edits.ts          EditDocument, applyOp, undo/redo, withTransaction
  tools.ts          active tool, tool-local transient state

apps/web/src/features/overlay/
  PageOverlay.vue       SVG layer, one per mounted page
  ObjectLayer.vue       renders objects declaratively
  SelectionChrome.vue   DOM handles, snap-free drag/resize/rotate
  TextEditor.vue        absolutely-positioned contenteditable
  InkCanvas.vue         transient canvas for in-flight strokes
  objects/*.vue         one presentational component per ObjectKind

apps/web/src/features/tools/
  ToolRail.vue          desktop, 64px (DesktopShell.vue:35 slot)
  ToolStrip.vue         mobile, scrollable (MobileShell.vue:50 slot)
  Inspector.vue         desktop, 320px (DesktopShell.vue:63 slot)
  InspectorSheet.vue    mobile bottom sheet
  SelectionToolbar.vue  floating, follows selection

apps/web/src/features/signature/
  SignatureModal.vue  draw / type / upload
  removeBackground.ts luminance-threshold → alpha

apps/web/src/lib/
  fonts.ts          FontFace loading, canvas measureText, preview↔export parity
  exportFile.ts     Blob → download
```

### 1.2 The edit store

Exactly as PLAN.md §1.2 specifies. `EditDocument` is a plain serialisable object; every mutation goes through `applyOp(op)`; objects reference a synthetic `pageId`, never a page index; undo/redo uses Immer's `produceWithPatches`, so no hand-written `invert()` per op type.

Three points where the design makes a call §1.2 left implicit:

1. **The store exposes `applyOp` and getters. Nothing else.** No exported mutations, no `$patch` from components. This repo has no linter, so the invariant is enforced structurally instead: `edits.ts` is a **setup store** that returns `readonly()` state plus `applyOp` — the same pattern `stores/viewport.ts` already uses for `zoom` (commit `07d4ba1`). A component assigning to state is then a *type error*, not a convention. A unit test asserting the store's exported surface backs it up, so adding a second write path fails CI rather than eroding quietly.
2. **`withTransaction(label, fn)` is mandatory for drags, resizes, freehand strokes, and typing.** Typing commits on 400ms idle or blur. Without this, one drag is 60 undo steps.
3. **History is capped at 200 entries** *and* a byte ceiling on accumulated patches, dropping oldest. Image ops carry large payloads; an entry count alone is not a memory bound.

`stores/edits.ts` holds no PDF bytes and no DOM references — that is what makes Phase 4's IndexedDB autosave and crash recovery fall out for free.

### 1.3 The overlay

Three stacked layers sharing one CSS box, per PLAN.md §1.3. Layer 1 (the bitmap canvas) already exists as `PageCanvas.vue`.

Layer 2 is an `<svg>` whose `viewBox` is the page's PDF dimensions, with all three of MuPDF's baked-in page-space transforms on a single root `<g transform>`. **Both of those strings already exist and are already property-tested**: `svgViewBox(geometry)` and `svgRootTransform(geometry)` in `@margin/transform`. Phase 2 consumes them; it does not write new coordinate maths.

The payoff: objects render at their raw stored PDF coordinates with zero per-object arithmetic, and zoom is nothing but a CSS width change on the SVG.

Layer 3 is DOM, not SVG — selection box, handles, guides, and text editing via an absolutely-positioned `contenteditable`. SVG text editing breaks IME and mobile keyboards.

**Virtualisation:** only pages within ±1 of the viewport mount an overlay, matching the existing `PageList.vue` window. Off-screen pages keep their bitmap and drop their objects from the DOM.

---

## 2. The write path

`replay(sourceBytes, editDoc, opts)` is a pure function. It opens a fresh `PDFDocument` from the pristine bytes, walks `editDoc.pageOrder`, dispatches each object to its writer keyed on `kind`, and returns `saveToBuffer('compress,garbage=compact')`.

```
replay(sourceBytes, editDoc)
  │
  ├─ session.open(sourceBytes)          try { … } finally { doc.close() }
  ├─ for each pageId in editDoc.pageOrder
  │    ├─ page = doc.loadPage(sourceIndex)   try { … } finally { page.destroy() }
  │    └─ for each object on page, sorted by z
  │         ├─ kind ∈ {highlight,underline,strikeout,ink} → annots.ts  (page space, scale 1)
  │         ├─ kind === 'link'                            → links.ts   (createLink)
  │         └─ everything else                            → content.ts (raw PDF space)
  └─ doc.saveToBuffer('compress,garbage=compact')
```

**Disposal is a correctness requirement, not hygiene.** Phase 0 measured that omitting `.destroy()` does not leak gradually — it hard-crashes the WASM heap with `malloc failed` inside a single few-hundred-page sweep. `session.ts` owns this discipline so no object writer can forget it.

**Object writers never touch the document directly.** Each receives a drawing context and emits primitives. That keeps every writer independently unit-testable and keeps the MuPDF surface area in two files instead of nine.

---

## 3. The coordinate contract — the sharpest trap in this phase

Phase 2's write path has **two different coordinate conventions running simultaneously**, and mixing them produces subtly-misplaced output that looks fine on unrotated letter-size pages and wrong everywhere else. `write/coords.ts` is the single owner of both.

**Convention A — annotation setters use page space at scale 1.** Phase 0 measured this directly (`02-write-path.md` Q2): `setRect`, `setQuadPoints`, `setLine`, and `getRect` are top-down with y=0 at the top of the CropBox, and MuPDF's binding flips y transparently on every get/set. Verified two independent ways — a round-trip showing `setRect([72,400,200,460])` reading back identically while the raw on-disk `/Rect` was `[71,331,201,393]`, and pixel-sampling a render that matched the unflipped formula within 1–3px while the naive PDF-spec flip was off by 120–140px.

> **Rule:** feed annotation setters `pdfToView(p, geometry, 1)` — page space at **scale 1, unscaled points**. Never the zoom-scaled view pixels `pdfToView` returns for on-screen rendering, and **never** a manual bottom-up flip. Passing a zoom-scaled rect is silently accepted and lands the annotation at a multiple of the correct offset.

**Convention B — content-stream operators use raw bottom-up PDF space.** No flip, origin bottom-left, exactly as stored in `EditObject.rect`.

So the same logical rectangle is written two different ways depending on whether it becomes an annotation or page content. `coords.ts` exposes exactly two functions — `toAnnotSpace(rect, geometry)` and `toContentSpace(rect, geometry)` — and no writer computes coordinates itself.

**This is the one place the design rests on something Phase 0 did not measure.** The findings are explicit: content-stream drawing was verified end-to-end as a standalone `Pixmap` (`Font` + `Text` + `Device`, measured accurate to 5 decimal places), but *"wiring this into an actual page content-stream edit … was not tested"*. The same gap applies to `page.createLink`'s `bbox` argument — `getURI()` round-tripped exactly, but the bbox's coordinate space was never checked.

**Therefore Task 24 opens with a coordinate-pinning test**, before any object writer is built: draw a known rect and a known text run at known coordinates via each convention, save, re-render, and assert the marks land on the expected pixels. Both conventions get pinned by a golden test that runs on every commit thereafter. If Convention B turns out not to be raw bottom-up, that is a two-line fix in one file discovered on day one — not a systematic misplacement discovered after nine writers are built on it.

---

## 4. Data flow

```
 user gesture
     │
     ▼
 tools.ts (transient)  ──── pointer stream, never enters history
     │
     ▼  on commit
 applyOp(op) ─── produceWithPatches ─── history.push({patches, inversePatches})
     │
     ▼
 EditDocument (reactive)
     │
     ├──────────────▶ overlay re-renders (SVG, declarative, no bitmap work)
     │
     └── Download ──▶ Comlink ──▶ PdfService.save(editDoc)
                                       │
                                       ▼
                                  replay(#sourceBytes, editDoc)
                                       │
                                       ▼
                                  Uint8Array ──▶ Blob ──▶ download
```

The preview and the export read the *same* `EditDocument` through two different renderers. That is the correctness risk of the whole phase, and it is why golden tests compare a re-rendered export against the on-screen expectation rather than merely asserting the export parses.

---

## 5. Error handling

| Failure | Handling |
|---|---|
| Export throws mid-replay | Fail the whole export, surface which page and object kind failed. Never hand the user a partial PDF that silently dropped their signature. |
| A single object writer fails | Same — fail loudly. A missing annotation is worse than a failed download because the user won't notice it. |
| Font not loaded when text is drawn | Block export until `document.fonts.ready`; if a face genuinely failed to load, refuse and name the font rather than substituting silently. |
| Image too large to embed | Downscale before embed with a stated ceiling; warn if the source exceeded it. |
| `javascript:` or malformed link URL | Rejected at op-creation time in the store, not at export. Invalid state should be unrepresentable. |
| Worker dies during export | The existing `pdfClient` readiness handshake already covers boot; export adds a timeout and a retryable error state. |
| History memory ceiling hit | Drop oldest entries silently — this is expected operation, not an error. |

---

## 6. Testing

Four layers, mirroring what Phase 1 established.

1. **Store unit tests (`web`)** — `applyOp` for every op type, inverse-patch round-trips (apply → undo → deep-equal original), transaction coalescing, history cap, and the "only `applyOp` writes" surface assertion. Fast, no PDF involved.
2. **Write-path unit tests (`pdf-core`)** — each object writer against a fixture document, asserting structure: annotation subtype, `/AP` presence, `/QuadPoints` values, content-stream operators emitted.
3. **Golden export tests (`pdf-core`)** — the load-bearing layer. Build an `EditDocument`, replay it, re-render in Node, pixel-compare against a committed golden. This reuses the rig already built in Phase 0 (`packages/pdf-core/test/golden.ts`, `UPDATE_GOLDENS=1`), so it costs a fixture per tool, not a new harness.
4. **E2E (`playwright`)** — place an object, undo, redo, download, and assert the downloaded bytes reopen with the object present. Extends the existing `apps/web/e2e/viewer.spec.ts` patterns.

**Human verification gate.** Phase 0 verified native annotations across MuPDF and Apple CoreGraphics — pixel-identical, no disagreement — but Acrobat and Chrome were never opened, because that environment had no GUI. PLAN.md's Phase 2 milestone names all three viewers explicitly. **This cannot be automated and it is not optional**; the final task produces a checklist and the sample exports to open. `docs/findings/evidence/out-annots.pdf` already exists for the annotation half.

---

## 7. Task sequence

| # | Task | Group |
|---|---|---|
| 22 | Retain source bytes · `PdfService.save()` · `write/session.ts` · Download live for unedited documents | Spine |
| 23 | `EditDocument` + op vocabulary + `applyOp` + Immer undo/redo + `withTransaction` | Spine |
| 24 | **Coordinate-pinning tests** · `write/coords.ts` · `replay()` · golden export rig | Spine |
| 25 | `PageOverlay.vue` — SVG layer, declarative object rendering, ±1 virtualisation | Overlay |
| 26 | Selection + transform handles, hit-testing via `getScreenCTM().inverse()` | Overlay |
| 27 | Tool rail (desktop) + tool strip (mobile) + `tools.ts` state machine | Chrome |
| 28 | Inspector panel + mobile bottom sheet + floating selection toolbar | Chrome |
| 29 | Shapes — rect, ellipse, line, arrow | Tools |
| 30 | Whiteout (named honestly per §2.1 — it covers, it does not remove) | Tools |
| 31 | Text tool — `FontFace` loading, `contenteditable`, `measureText`, content-stream text | Tools |
| 32 | Image — decode, downscale, EXIF orientation, XObject embed | Tools |
| 33 | Freehand ink — `perfect-freehand`, transient canvas, native `Ink` annotation | Tools |
| 34 | Links — `createLink`, URL validation, detect existing links on load | Tools |
| 35 | Signature — draw/type/upload, background removal, IndexedDB reuse | Tools |
| 36 | Text-quad index — `toStructuredText().asJSON()` + `walk({onChar})`, per page, cached | Markup |
| 37 | Text selection — hit-testing and selection rendering over the bitmap | Markup |
| 38 | Highlight / underline / strikeout — native annotations with `/QuadPoints` | Markup |
| 39 | Export progress reporting, error surfaces, large-document behaviour | Close |
| 40 | Full golden suite · Acrobat/Preview/Chrome verification checklist | Close |

Tasks 22–24 are the spine: at the end of Task 24 there is a working Download, a complete edit store, and a golden-test rig — with no tools yet. Every task from 29 onward follows the same shape (overlay renderer · inspector controls · object writer · golden test) and is therefore independently reviewable.

**New runtime dependencies:** `immer` (Task 23), `perfect-freehand` (Task 33), `dexie` (Task 35, signature reuse only). `pdf-lib` and `@pdf-lib/fontkit` are **not** added — that moves to Phase 4 with font subsetting.

---

## 8. Explicitly out of scope

Deferred to **Phase 3**: rotate, delete, reorder, crop, extract, split, merge.
Deferred to **Phase 4**: font subsetting via `pdf-lib`/`@pdf-lib/fontkit`; snapping and alignment guides; IndexedDB autosave and crash recovery (Phase 2 uses IndexedDB only for saved signatures); the ⌘K palette; the full a11y pass; the 300-page perf pass.
Deferred to **Phase 5+**: forms, text patching, find & replace, redaction, watermarks, metadata, compression, password protection.

## 9. Housekeeping folded in

Two small things found during the Phase 1 audit, fixed inside the tasks that touch them rather than as separate work:

- **`TopBar.vue`'s Download button has no tooltip** — the only control in that header without one, so its disabled state reads as broken rather than as pending. Task 22 removes `disabled` entirely, which resolves it.
- **Node version drift** — `package.json` requires `>=22`; the current shell runs v20.16.0 and pnpm warns on every command. Worth pinning via `.nvmrc` in Task 22 so the toolchain matches what CI and the `engines` field assume.
