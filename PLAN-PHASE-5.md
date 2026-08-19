# Phase 5 — Forms Implementation Plan

> **For agentic workers:** implement task-by-task. Each task ends green on all four gates
> (`pnpm test`, `pnpm -r typecheck`, `pnpm -r build`, `pnpm --filter @margin/web e2e`) and commits.

**Goal:** Fill the fields a PDF already has, create new ones, and optionally flatten them on export.

**Architecture:** Filling is a value map on `EditDocument`; creating is a new `field` object kind.
They meet only in the write path. DOM inputs positioned over widget rects handle filling.

**Spec:** `PHASE-5-DESIGN.md`. **Pre-flight:** `docs/findings/12-phase-5-preflight.md`.

## Global Constraints

Copied from the spec and the pre-flight; every task inherits these.

- **Widget `/Rect` is Convention B** (raw PDF user space, bottom-up, CropBox not normalised) and is
  written through `toContentSpace()`, the identity — **not** `toAnnotSpace()`, which is for mupdf's
  setters and would put a field meant for the bottom of a page at its top. **`getBounds()` returns
  Convention A** (top-down, CropBox normalised, `/Rotate` applied) — the renderer's space, which the
  overlay consumes unconverted. Findings 12 §4 and its correction.
- **Assert exact bounds, never containment.** A field written in the wrong space is still inside the
  page box; three of four rotations pass a containment check.
- **Never read a radio button's selection from `getValue()`.** It returns the group's value. Use
  `/AS`. Findings 12 §3.
- **Radio kids require an explicit `/AP /N` with the button's export value and `Off` as its two
  keys.** Without it every kid falls back to the on-state `Yes` and they become one button, silently.
  Findings 12 §1.
- **A widget added by raw object work is invisible to `getWidgets()` until save and reopen.** Every
  round-trip assertion goes through a save/reopen. Findings 12 §5.
- **Every checkbox and radio needs `/MK /BC`** or its unchecked state renders invisibly. Phase 0.
- Flag values: radio `32768`, no-toggle-off `16384`, read-only `1`, required `2`, multiline
  `TX_FIELD_IS_MULTILINE`, combo `CH_FIELD_IS_COMBO`.
- Fields the app creates carry **no scripts, ever** (`PHASE-5-DESIGN.md` §9).
- Colours are sRGB `[r, g, b]` each 0..1.

---

## File Structure

**pdf-core**
- `src/write/types.ts` — modify: `FieldObject`, `FieldValue`, v3 `EditDocument` members
- `src/write/migrate.ts` — modify: v2 → v3 step
- `src/write/objects/field.ts` — create: `ensureAcroForm`, `writeField`
- `src/write/fieldAppearance.ts` — create: two-state appearance streams
- `src/write/fields.ts` — create: `applyFieldValues`, `listFields`
- `src/write/index.ts` — modify: register the writer, apply values, flatten

**web**
- `src/stores/edits.ts` — modify: `setFieldValue`, `setFlattenForms`, `setTabOrder`
- `src/stores/fields.ts` — create: per-page `SourceField` cache
- `src/features/forms/FieldLayer.vue` — create: the DOM fill overlay
- `src/features/forms/FieldControl.vue` — create: one control, by type
- `src/features/forms/fieldGeometry.ts` — create: Convention A rect → overlay box
- `src/features/tools/Inspector.vue` — modify: field properties
- `src/features/tools/TabOrderList.vue` — create
- `src/app/TopBar.vue` — modify: flatten checkbox
- `src/workers/pdfService.ts`, `pdfClient.ts` — modify: `listFields`

---

## Task 66: Schema v3 and migration

**Files:** modify `packages/pdf-core/src/write/types.ts`, `migrate.ts`;
test `packages/pdf-core/test/write/migrate.test.ts`

**Produces:** `FieldObject`, `FieldValue`, `EditDocument.fieldValues`, `EditDocument.flattenForms`,
`EDIT_DOCUMENT_VERSION = 3`.

- [ ] Add `FieldValue`, `FieldObject` (per design §1), add `'field'` to `ObjectKind`, add
      `FieldObject` to the `EditObject` union, add `fieldValues` and `flattenForms` to
      `EditDocument`, bump `EDIT_DOCUMENT_VERSION` to 3.
- [ ] Add the v2 → v3 step to `migrateEditDocument`: `fieldValues: {}`, `flattenForms: false`.
- [ ] Tests: a v1 document migrates all the way to v3; a v2 document gains both defaults and keeps
      its pages and objects; a v4 document is still refused by name.
- [ ] Update every `EditDocument` literal in tests and app code that sets `version` explicitly.
- [ ] Gates, commit.

## Task 67: AcroForm wiring and the text field writer

**Files:** create `packages/pdf-core/src/write/objects/field.ts`;
test `packages/pdf-core/test/write/field.test.ts`

**Consumes:** Task 66's `FieldObject`. **Produces:** `ensureAcroForm(raw): PDFObject`,
`writeField(ctx, object)`.

- [ ] `ensureAcroForm`: return the existing `/AcroForm` if present, else create one with `/Fields`,
      `/DA "/Helv 0 Tf 0 g"`, and `/DR /Font /Helv` (Helvetica Type1). **Idempotent** — a source
      document's own AcroForm must never be clobbered.
- [ ] `writeField` for `fieldType: 'text'`: widget annotation dict with `/FT /Tx`, `/T`, `/V`,
      `/DA`, `/F 4`, `/Rect` via `toContentSpace(object.rect)`, `/Ff` from `required`,
      `readOnly`, `multiline`, `/MaxLen` when set. Push to `/AcroForm /Fields` and the page's
      `/Annots`.
- [ ] Register `WRITERS.field = writeField` in `src/write/index.ts`.
- [ ] Tests (all through save + reopen, per Global Constraints): a text field round-trips with the
      right name, type, and value; multiline and read-only flags survive; `/MaxLen` survives;
      an existing `/AcroForm` is extended rather than replaced; a field on each of `/Rotate`
      0/90/180/270 and on an offset-CropBox page reads back from `getBounds()` at **exactly** the
      Convention A rect, not merely somewhere inside the page.
- [ ] Gates, commit.

## Task 68: Checkbox, radio, and the appearance generator

**Files:** create `packages/pdf-core/src/write/fieldAppearance.ts`; modify `objects/field.ts`;
test `field.test.ts`

**Produces:** `onAppearance(raw, w, h): PDFObject`, `offAppearance(raw, w, h): PDFObject`.

- [ ] `fieldAppearance.ts`: `/Subtype /Form` XObjects with `/BBox [0 0 w h]`; on-state draws a
      filled dot centred in the box, off-state is empty.
- [ ] `writeField` for `'checkbox'`: `/FT /Btn`, `/AS`, `/MK /BC` (black border — without it the
      unchecked state is invisible), `/AP /N << /Yes … /Off … >>`, `/V` from `value`.
- [ ] `writeField` for `'radio'`: group the objects by `group`. One parent field per group with
      `/FT /Btn`, `/Ff 32768|16384`, `/T`, `/V`, `/Kids`; one kid per object with `/Parent`,
      `/Rect`, `/AS`, `/MK /BC`, and `/AP /N` keyed by **this button's `exportValue`** and `Off`.
      Only the parent goes in `/AcroForm /Fields`; the kids go in `/Annots`.
- [ ] Tests: a checkbox round-trips checked and unchecked, and carries `/MK /BC`; a three-button
      radio group produces one parent and three kids; **`/AS` reads `[Off, x, Off]` after selecting
      the middle button, asserted on `/AS` and not `getValue()`**; each kid's `/AP /N` carries its
      own export value, so no two kids share an on-state name; the group survives save and reopen
      with exclusion intact.
- [ ] Gates, commit.

## Task 69: Choice fields and the signature box

**Files:** modify `objects/field.ts`; test `field.test.ts`

- [ ] `'dropdown'`: `/FT /Ch` with `CH_FIELD_IS_COMBO`, `/Opt` array from `options`.
- [ ] `'listbox'`: `/FT /Ch` without the combo flag.
- [ ] `'signature'`: `/FT /Sig`, no value. A place for a signature, not a signature.
- [ ] Tests: options round-trip in order; `isComboBox()` distinguishes the two; a selected value
      survives; the signature field reports type `signature` and holds no value.
- [ ] Gates, commit.

## Task 70: Reading the fields a document already has

**Files:** create `packages/pdf-core/src/write/fields.ts`;
modify `apps/web/src/workers/pdfService.ts`, `pdfClient.ts`;
test `packages/pdf-core/test/write/fields.test.ts`

**Produces:** `SourceField`, `listFields(raw, index): SourceField[]`,
`pdfClient.listFields(sourceId, index)`.

- [ ] `listFields`: walk `page.getWidgets()`, reading name, type, `getBounds()` (Convention A,
      unconverted), value, options, and flags. **Radio state comes from the raw `/AS`, never from
      `getValue()`.**
- [ ] Key: the fully-qualified name, or `#unnamed:<pageId>#<index>` when `/T` is absent.
- [ ] Expose through the worker with the existing `#docFor()` source handling, so a merged
      document's fields are readable too.
- [ ] Tests: every field type is reported with the right type and rect; a radio group reports each
      button's own `state`, and exactly one is on; a document with no form returns `[]`; an unnamed
      field gets a positional key.
- [ ] Gates, commit.

## Task 71: Applying filled values on export

**Files:** create/modify `packages/pdf-core/src/write/fields.ts`; modify `src/write/index.ts`;
test `fields.test.ts`

**Produces:** `applyFieldValues(raw, editDoc): void`.

- [ ] Walk every page's widgets, match by key, set the value: `setTextValue`, `setChoiceValue`,
      or raw `/V` + `/AS` for buttons.
- [ ] Call it in `replay` **after** the object writers, so a field created this session can be
      filled in the same export.
- [ ] A key matching nothing is skipped silently — it means the page was deleted after the fill.
- [ ] `hasObjects`-style guard: a non-empty `fieldValues` must defeat the byte-identical
      pass-through, exactly as objects do.
- [ ] Tests: filling a text field puts the value in the exported bytes; filling a checkbox sets
      `/AS`; a stale key is ignored rather than throwing; filling defeats pass-through; a form
      document with no fills still exports byte-identically.
- [ ] Gates, commit.

## Task 72: Flatten forms on export

**Files:** modify `packages/pdf-core/src/write/index.ts`, `apps/web/src/app/TopBar.vue`,
`apps/web/src/stores/edits.ts`; tests `field.test.ts`, `apps/web/test/features/flatten.test.ts`

- [ ] `replay` calls `raw.bake(false, true)` immediately before `saveToBuffer` when
      `editDoc.flattenForms`. Never on the document being edited.
- [ ] `setFlattenForms(on)` in the edit store — an undoable op like any other.
- [ ] A checkbox in the download flow, **off by default**, labelled so the one-way door is legible.
- [ ] Tests: flattening removes the widgets and leaves the value in the page text; **an ink
      annotation survives a widgets-only bake**; `/AcroForm` is gone; off by default; flattening
      defeats pass-through.
- [ ] Gates, commit.

## Task 73: The fill overlay

**Files:** create `apps/web/src/features/forms/{FieldLayer,FieldControl}.vue`,
`fieldGeometry.ts`, `apps/web/src/stores/fields.ts`; modify `PageOverlay.vue`, `edits.ts`;
tests `apps/web/test/features/FieldLayer.test.ts`, `test/stores/fields.test.ts`

**Produces:** `useFieldsStore()` with a per-`(sourceId, index)` cache; `setFieldValue(key, value)`.

- [ ] `fields.ts` store: fetch and cache `SourceField[]` per page; never re-fetch on scroll.
- [ ] `FieldControl.vue`: `<input>`, `<textarea>`, `<select>`, or checkbox/radio by type. Opaque
      background so the rendered original does not show through. Read-only renders disabled.
- [ ] `FieldLayer.vue`: position each control from the Convention A rect with the page transform;
      sits **below** `ObjectLayer` and never participates in selection or drag.
- [ ] `setFieldValue` coalesces per field, so typing a name is one undo entry rather than eleven.
- [ ] Tests: a control per field, of the right type; typing writes to the store and is undoable as
      one entry; read-only is disabled; radio checked state comes from `state`, so **no more than
      one button in a group renders checked**; clicking a field does not select an object; the
      cache is not re-fetched on re-render.
- [ ] Gates, commit.

## Task 74: The field tool and creating fields

**Files:** modify `apps/web/src/features/tools/toolList.ts`, `src/stores/tools.ts`,
`src/features/overlay/useDrawTool.ts`; create
`apps/web/src/features/overlay/objects/FieldObject.vue`;
tests `apps/web/test/features/fieldTool.test.ts`

- [ ] One **Form field** tool. Drag a rect, get a text field with a generated unique name.
- [ ] `FieldObject.vue` draws the field's box and type in the overlay, like every other object.
- [ ] Radio: drawing with the type set to radio adds a button to the current group.
- [ ] Tests: dragging creates a `field` object with the drawn rect; names are unique; the object is
      selectable, movable, and undoable like any other; a second radio joins the first's group.
- [ ] Gates, commit.

## Task 75: Field properties

**Files:** modify `apps/web/src/features/tools/{Inspector.vue,inspectorFields.ts}`;
tests `apps/web/test/features/Inspector.test.ts`

- [ ] Type selector, name, required, read-only, default value, multiline, max length, and options
      (for choice types). Radio shows its group's buttons and their export values.
- [ ] The signature field says plainly that it is a place for a signature and not a signature.
- [ ] Tests: changing the type rewrites the object's `fieldType`; each property is undoable; the
      options editor adds and removes; an empty name is refused, because an unnamed field cannot
      hold a value.
- [ ] Gates, commit.

## Task 76: Tab order

**Files:** create `apps/web/src/features/tools/TabOrderList.vue`;
modify `packages/pdf-core/src/write/objects/page.ts`, `types.ts`, `edits.ts`;
tests `apps/web/test/features/TabOrderList.test.ts`, `packages/pdf-core/test/write/field.test.ts`

- [ ] `tabOrder: string[]` per page in the edit document; absent means document order.
- [ ] On export, order the page's `/Annots` accordingly and set `/Tabs /R`.
- [ ] A reorderable list in the inspector, reusing `useDragReorder`.
- [ ] Tests: reordering changes the exported `/Annots` order; `/Tabs /R` is set; a page with no
      explicit order is untouched; a stale key in `tabOrder` is ignored.
- [ ] Gates, commit.

## Task 77: End-to-end

**Files:** create `apps/web/e2e/forms.spec.ts`, a form fixture in `apps/web/e2e/fixtures/`

- [ ] Fixture: a PDF with a text field, a checkbox, and a three-button radio group.
- [ ] Tests, on both desktop and phone: fields render as real inputs; typing and downloading puts
      the value in the exported bytes; selecting one radio deselects the others; creating a field
      and downloading produces a document whose field is present on reopen; flattening removes the
      fields.
- [ ] Gates, commit.

## Task 78: Phase verification

**Files:** create `docs/findings/13-phase-5-verification.md`; modify `PLAN.md` §7

- [ ] Full run of all four gates. Record what is covered and what is not.
- [ ] Carry forward the outstanding cross-viewer and real-phone checks, and add this phase's own:
      **the spec requires human verification that created fields are actually interactive in Acrobat
      and Chrome**, which no agent here can do.
- [ ] Update `PLAN.md` §7's Phase 5 entry.
- [ ] Commit, merge to master.

---

## Plan self-review

**Spec coverage.** Design §1 → Task 66. §2 → Task 70. §3 → Task 73. §4 → Task 74. §5 → Tasks 67–69.
§6 → Task 71. §7 → Task 76. §8 → Task 72. §9 needs no task; it is a statement about what is absent.
§10 is distributed across every task's tests plus Task 77.

**Pre-flight coverage.** Findings 12 §1 → Task 68. §2 → Task 68. §3 → Tasks 68, 70, 73. §4 → Tasks
67, 70. §5 → Global Constraints, binding on every write-path test. §6 → Tasks 67, 68. §7 → Task 72.

**Ordering.** The write path (66–72) precedes the UI (73–76), so every UI task has something real to
write to. Reading existing fields (70) precedes the fill overlay (73) that consumes it. Applying
values (71) precedes flatten (72), because flatten has to bake values that are already applied.
