# Phase 6 — Advanced document ops Implementation Plan

> **For agentic workers:** implement task-by-task. Each task ends green on all four gates
> (`pnpm test`, `pnpm -r typecheck`, `pnpm -r build`, `pnpm --filter @margin/web e2e`) and commits.

**Goal:** Stamping, redaction, password protection, metadata, compression, find & replace, and
line-level text patching.

**Architecture:** Most features are new object kinds or new export-time passes on the assembled copy.
Text patching is last so it can slip without blocking the rest.

**Spec:** `PHASE-6-DESIGN.md`. **Pre-flight:** `docs/findings/14-phase-6-preflight.md`.

## Global Constraints

From the pre-flight; every task inherits these.

- **Never report a password-protected export without reopening the output and asserting
  `needsPassword() === true`.** Two silent failure modes exist — passwords with no `encrypt=`, and
  `encrypt=` with no password — and both save cleanly, throw nothing, and produce a file that looks
  protected. Findings 14 §2.
- **Never hand back a "compressed" file larger than the original.** The structural pass grows files.
  Measure and fall back. Findings 14 §5.
- **Redaction defaults to black boxes.** `applyRedactions(false)` removes text and draws nothing.
  Findings 14 §1.
- **Redaction is text-only.** The image and line-art paths are unexercised; do not offer them.
- **`isStream()` follows an indirect reference; the resolved object reports false.** Test the
  reference and pass the reference to `loadImage`. Findings 14 §7.
- Permission bits: print 4, edit 8, copy 16, annotate 32, form 256, accessibility 512, assemble 1024,
  print-hq 2048. Findings 14 §3.
- **Never call anything but redaction "redact".** Whiteout covers. Phase 2's copy stands.
- Colours are sRGB `[r, g, b]` each 0..1. Rects are raw PDF user space unless a comment says
  otherwise.

---

## File Structure

**pdf-core**
- `src/write/types.ts` — modify: `StampObject`, `RedactionObject`, `TextPatchObject`, document-level
  `metadata`, `protection`, `compression`
- `src/write/objects/stamp.ts` — create: the one stamping writer
- `src/write/objects/redact.ts` — create
- `src/write/protect.ts` — create: encryption + the mandatory self-check
- `src/write/metadata.ts` — create: `/Info` + XMP together
- `src/write/compress.ts` — create: image recompression with a size floor
- `src/write/subset.ts` — create: pdf-lib + fontkit
- `src/text/find.ts` — create: normalised search over the quad index
- `src/write/objects/patch.ts` — create: cover-and-redraw

**web**
- `src/features/stamp/StampDialog.vue`, `stampPresets.ts`
- `src/features/redact/RedactTool.vue`
- `src/features/protect/ProtectDialog.vue`
- `src/features/metadata/MetadataDialog.vue`
- `src/features/compress/CompressDialog.vue`
- `src/features/find/FindPanel.vue`, `useFind.ts`
- `src/features/patch/PatchEditor.vue`

---

## Task 79: The stamping writer

**Files:** create `packages/pdf-core/src/write/objects/stamp.ts`; modify `types.ts`, `index.ts`;
test `packages/pdf-core/test/write/stamp.test.ts`

**Produces:** `StampObject`, `writeStamp`, `resolveTokens(template, ctx)`.

- [ ] `StampObject`: `kind: 'stamp'`, `template`, `font`, `behind`, plus `BaseObject`.
- [ ] `resolveTokens`: `{n}`, `{total}`, `{filename}`, `{date}`, `{bates}`. One resolver for every
      stamp kind, so a token that works in a footer works in a watermark.
- [ ] `writeStamp`: content-stream text via the Phase 2 text writer's primitives. `behind: true`
      **prepends** to the content stream; `false` appends.
- [ ] Tests: each token resolves per page; a stamp lands at the right place on `/Rotate` 90/180/270
      and an offset CropBox (exact bounds, not containment); `behind` orders correctly against
      existing content; the stamp is content, not an annotation — `getAnnotations()` is empty.
- [ ] Gates, commit.

## Task 80: The stamp dialog

**Files:** create `apps/web/src/features/stamp/{StampDialog,stampPresets}.vue|ts`;
tests `apps/web/test/features/StampDialog.test.ts`

- [ ] Presets for watermark, page numbers, header, footer, Bates — the four differ by position,
      default template, and rotation, not by code path.
- [ ] Page range via `lib/pageRanges.ts` (Phase 3).
- [ ] Live preview on the anchor page before committing.
- [ ] One op for the whole range, so applying to 300 pages is one undo.
- [ ] Tests: each preset produces the objects it claims; a range applies to exactly those pages;
      Bates numbering increments with start/step/digits; one undo removes the lot.
- [ ] Gates, commit.

## Task 81: Redaction, write path

**Files:** create `packages/pdf-core/src/write/objects/redact.ts`; modify `index.ts`;
test `packages/pdf-core/test/write/redact.test.ts`, `test/write/redact-independent.test.ts`

**Produces:** `RedactionObject` (carries `quads`, like `MarkupObject`), `applyRedactionsPass`.

- [ ] Redactions are applied as a **pass on the assembled export copy**, after object writers and
      before save — a `Redact` annotation per object, then `page.applyRedactions(blackBoxes)`.
- [ ] `blackBoxes` defaults true.
- [ ] Tests, mirroring the pre-flight so the gate is re-checked on every commit: a word, a word
      mid-line, part of a word, all four rotations; neighbours survive; the text is absent from the
      raw bytes.
- [ ] **The independent-extractor test.** A separate spec that shells out to a Python venv running
      `pypdf` and `pdfminer.six` over the redacted output. Skips with a loud message if the venv is
      absent rather than silently passing — a safety gate that quietly no-ops is worse than none.
- [ ] Gates, commit.

## Task 82: The redact tool

**Files:** create `apps/web/src/features/redact/RedactTool.vue`; modify `toolList.ts`, `tools.ts`;
tests `apps/web/test/features/redact.test.ts`

- [ ] Text-selection driven, reusing Phase 2's `useTextSelection` — the same gesture as highlight.
- [ ] Redacted runs render as solid black in the editor, so the preview matches the export.
- [ ] Copy: the tool says the text is **removed**, in contrast to whiteout's notice, and the whiteout
      notice gains a pointer to it.
- [ ] Tests: selecting text and applying produces a redaction object with those quads; it is
      undoable; the editor preview is opaque; the whiteout notice points here.
- [ ] Gates, commit.

## Task 83: Password and permissions, write path

**Files:** create `packages/pdf-core/src/write/protect.ts`; modify `types.ts`, `index.ts`;
test `packages/pdf-core/test/write/protect.test.ts`

**Produces:** `Protection` (`userPassword`, `ownerPassword`, `permissions`), `protectedSave`.

- [ ] Build the option string, save, then **reopen and assert `needsPassword()`**; throw a named
      error if not.
- [ ] `PERMISSION_BITS` from findings 14 §3.
- [ ] Tests: **both silent failure modes are caught** — passwords without `encrypt=`, and `encrypt=`
      with no password. Each bit grants exactly its permission. A protected file opens with the
      password and refuses without it. Removing protection needs the user password.
- [ ] Gates, commit.

## Task 84: The protect dialog

**Files:** create `apps/web/src/features/protect/ProtectDialog.vue`;
tests `apps/web/test/features/ProtectDialog.test.ts`

- [ ] Open password, owner password, permission checkboxes.
- [ ] **States plainly that permissions are enforced by the viewer, not the file.** A user who
      believes "no copy" is a technical guarantee is being misled by omission.
- [ ] Tests: the caveat is present; a mismatched confirmation is refused; the permission checkboxes
      map to the right bits; a failed self-check surfaces as an error rather than a success.
- [ ] Gates, commit.

## Task 85: Metadata

**Files:** create `packages/pdf-core/src/write/metadata.ts`; modify `types.ts`, `index.ts`;
test `packages/pdf-core/test/write/metadata.test.ts`

- [ ] Read `/Info`; write `/Info` **and** an XMP `/Type /Metadata` stream from one source.
- [ ] `stripAll` removes `/Info`, XMP, and the document ID.
- [ ] Tests: a title round-trips through both; **`/Info` and XMP agree after a write** (the whole
      point); `CreationDate` survives and `ModDate` updates; strip removes both and leaves a valid
      document.
- [ ] Gates, commit.

## Task 86: The metadata dialog

**Files:** create `apps/web/src/features/metadata/MetadataDialog.vue`;
tests `apps/web/test/features/MetadataDialog.test.ts`

- [ ] Title, author, subject, keywords, creator. A "remove all metadata" action.
- [ ] Tests: fields load from the document; edits are undoable; strip clears the form and sets the
      flag.
- [ ] Gates, commit.

## Task 87: Compression

**Files:** create `packages/pdf-core/src/write/compress.ts`; modify `index.ts`;
test `packages/pdf-core/test/write/compress.test.ts`

**Produces:** `CompressionPreset`, `recompressImages(raw, preset): { before, after }`.

- [ ] Walk `/Resources /XObject` per page; `isStream()` on the **reference**; `loadImage(ref)` →
      `toPixmap()` → `asJPEG(quality)`; replace the stream and its `/Width`, `/Height`, `/Filter`.
- [ ] Downscale above the preset's max dimension.
- [ ] **The floor**: measure the final save and return the original bytes if not smaller.
- [ ] Tests: a photo-heavy document shrinks by roughly the preset's expected amount; **an
      already-small document is returned byte-identical rather than grown**; a document with no
      images is unchanged; a CMYK or indexed image is skipped rather than mangled.
- [ ] Gates, commit.

## Task 88: The compress dialog

**Files:** create `apps/web/src/features/compress/CompressDialog.vue`;
tests `apps/web/test/features/CompressDialog.test.ts`

- [ ] Three presets, with a measured before/after shown **before** committing.
- [ ] Tests: the estimate is shown before applying; choosing a preset changes it; a document that
      cannot be made smaller says so rather than offering a no-op.
- [ ] Gates, commit.

## Task 89: Font subsetting — ATTEMPTED, NOT DELIVERED (see findings 14 §6)

**Files:** create `packages/pdf-core/src/write/subset.ts`; modify `fonts.ts`;
test `packages/pdf-core/test/write/subset.test.ts`

- [ ] `pdf-lib` + `@pdf-lib/fontkit`, scoped strictly to subsetting and embedding. MuPDF stays the
      only engine for everything else.
- [ ] Subset to the glyphs actually drawn across the document.
- [ ] Tests: an export using one face embeds **2–3% of the raw font**, not 49–55%; the text still
      renders and extracts; two faces both subset; a face using no glyphs is not embedded at all.
- [ ] Gates, commit.

## Task 90: Find

**Files:** create `packages/pdf-core/src/text/find.ts`,
`apps/web/src/features/find/{FindPanel.vue,useFind.ts}`;
tests `packages/pdf-core/test/text/find.test.ts`, `apps/web/test/features/FindPanel.test.ts`

- [ ] Normalised search over `buildQuadIndex`: ligatures, irregular spacing, and words broken across
      spans, per §2.3. A naive `indexOf` misses most real matches.
- [ ] Case-insensitive by default; whole-word and case-sensitive options.
- [ ] Matches highlight in place; next/previous scroll to each.
- [ ] Tests: a word split across spans is found; `ﬁ` matches `fi`; case options behave; counts are
      right; no match says so.
- [ ] **Ships without replace**, which is useful alone and de-risks Task 93.
- [ ] Gates, commit.

## Task 91: Text patching, write path

**Files:** create `packages/pdf-core/src/write/objects/patch.ts`; modify `types.ts`, `index.ts`;
test `packages/pdf-core/test/write/patch.test.ts`

**Produces:** `TextPatchObject` (`{pageId, blockIdx, lineIdx, originalTextHash, text, ...}`).

- [ ] Cover with an opaque rect in the sampled background colour, then draw the new text.
- [ ] **The hash guard**: if the extracted run no longer hashes to `originalTextHash`, throw a named
      error rather than patching. Fail loudly; never silently mispatch.
- [ ] Background sampling with a variance-based confidence score.
- [ ] Glyph-miss detection with a metric-compatible fallback, reported to the caller.
- [ ] Fit modes: shrink, overflow, truncate.
- [ ] Tests: a patched run reads back as the new text; **a shifted extraction refuses to apply**; a
      missing glyph reports substitution rather than drawing nothing; low-confidence backgrounds are
      flagged; each fit mode behaves.
- [ ] Gates, commit.

## Task 92: The patch editor

**Files:** create `apps/web/src/features/patch/PatchEditor.vue`;
tests `apps/web/test/features/PatchEditor.test.ts`

- [ ] Double-click a run to edit it in place.
- [ ] **Per-run confidence**, not uniform editability: cleanly-patchable runs get a normal
      affordance, low-confidence ones are marked before the user commits.
- [ ] Substitution and fit warnings shown at edit time.
- [ ] Tests: editing a run creates a patch op; a low-confidence run is marked; a substitution warning
      appears; escape abandons.
- [ ] Gates, commit.

## Task 93: Replace

**Files:** modify `find.ts`, `FindPanel.vue`; tests as above

- [ ] Each hit becomes a text patch. Replace-all is **one transaction**, so it is one undo.
- [ ] Tests: replacing one hit leaves the others; replace-all is one undo entry; a hit whose run
      cannot be patched is reported rather than skipped silently.
- [ ] Gates, commit.

## Task 94: Phase verification

**Files:** create `docs/findings/15-phase-6-verification.md`; modify `PLAN.md` §7

- [ ] All four gates. Record coverage and gaps.
- [ ] Restate redaction's release gate as **met and continuously re-checked**, naming the CI test.
- [ ] Carry forward the human checks from Phases 4 and 5.
- [ ] Commit, merge to master.

---

## Plan self-review

**Design coverage.** §1 → Tasks 79–80. §2 → 81–82. §3 → 83–84. §4 → 87–88. §5 → 85–86. §6 → 90, 93.
§7 → 91–92. §8 → 89. §9 needs no task. §10 is distributed, plus Task 81's CI gate.

**Pre-flight coverage.** Findings 14 §1 → Tasks 81–82. §2 → 83. §3 → 83–84. §4 → 85. §5 → 87. §6 →
89. §7 → 87's Global Constraint.

**Ordering.** The eight tractable features (79–90) precede text patching (91–93), per the roadmap's
own instruction, so patching can slip without blocking a release. Find (90) precedes replace (93)
because replace is patching applied to search hits. Subsetting (89) precedes patching because
patching's fallback path embeds substitute faces.
