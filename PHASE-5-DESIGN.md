# Phase 5 — Forms

**Spec:** `PLAN.md` §2.2, §7. **Pre-flight:** `docs/findings/12-phase-5-preflight.md`, which is
load-bearing here rather than background: it overturned the spec's inference about radio groups and
settled the geometry question before any of this was designed.

## 0. The split that organises the whole phase

"Forms" is two features that share a vocabulary and almost nothing else.

**Filling a field that already exists** is answering a question someone else asked. The field has a
rect, a type, a name, and options — all of them already in the source document, none of them the
user's to move or restyle. The edit is a *value*, and nothing else.

**Creating a field** is authoring. It has a position the user drags out, a type they choose, and
properties they set. It is an object on a page, in the same sense every other Phase 2 object is.

The temptation is to model both as `EditObject`s and let filling be "an object whose rect happens to
come from the source". That is wrong, and expensively so:

- A filled field would become draggable, resizable, and z-ordered, because that is what the object
  overlay does with objects. Nothing about a form someone sent you should move when you tab into it.
- Opening a 40-field government form would materialise 40 objects in the edit document before the
  user has typed anything, so `isUntouched()` would report the document as edited and the
  byte-identical pass-through would never fire.
- Two widgets sharing a `/T` are **the same field** in PDF semantics and must hold the same value.
  Modelling them as two objects makes that a synchronisation problem instead of a property of the
  data.

So: **fill is a value map, create is an object.** They meet only in the writer, and only at the very
end.

## 1. Schema — v3

Two additions to `EditDocument`, and one new object kind.

```ts
export type EditDocument = {
  version: 3
  // ... v2 members unchanged ...
  /**
   * Values for fields that already exist in a source document, keyed by
   * fully-qualified field name.
   */
  fieldValues: Record<string, FieldValue>
  /** Flatten form fields into page content on export. */
  flattenForms: boolean
}

export type FieldValue = string | boolean | string[]
```

**Keyed by name, not position.** Two widgets with the same `/T` are one field, and keying by name
makes that fall out rather than needing to be maintained. Positional keys would also break the moment
a page was reordered or a second document merged in.

Unnamed fields — structurally invalid, but real files contain them — are keyed
`"#unnamed:<pageId>#<index>"`. A real `/T` reaching that form would have to start with `#unnamed:`,
and the positional part is stable because `pageId` survives reordering.

The new object kind:

```ts
export type FieldObject = BaseObject & {
  kind: 'field'
  fieldType: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'listbox' | 'signature'
  /** The field's /T. Unique per document except for radio buttons. */
  name: string
  /** Radio only: buttons sharing a group are kids of one parent field. */
  group: string | null
  /** Radio only: this button's on-state name, unique within the group. */
  exportValue: string | null
  value: FieldValue
  options: string[]
  required: boolean
  readOnly: boolean
  multiline: boolean
  maxLength: number | null
  /** 0 means auto-size, which is what a /DA of "0 Tf" asks for. */
  fontSize: number
}
```

`rect` follows the project rule — raw PDF user space, bottom-up — and reaches `/Rect` through
`toContentSpace()`, the identity, **not** `toAnnotSpace()`.

That is the opposite of every other annotation here, and the distinction is not the annotation: it
is the API. Convention A belongs to mupdf's *setters* — `setRect`, `setQuadPoints`, `createLink` —
which flip y and normalise the CropBox on the caller's behalf. A widget's `/Rect` is written as a raw
PDF object, which bypasses all of that. See the correction in findings 12 §4, which this contradicted
until Task 67's tests caught it.

**Migration.** `migrateEditDocument` gains a v2 → v3 step: `fieldValues: {}`, `flattenForms: false`.
Both defaults mean "a document with no forms behaves exactly as it did", which is what makes the step
safe to apply to every stored autosave record.

## 2. Reading the fields that are already there

A new worker call, because only the worker has the document:

```ts
listFields(sourceId: SourceId, sourceIndex: number): SourceField[]

export type SourceField = {
  key: string          // the fieldValues key
  name: string
  type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'listbox' | 'signature' | 'button'
  /**
   * MuPDF page space (Convention A) -- the renderer's space, so the DOM
   * overlay positions with the same transform every other layer uses.
   */
  rect: Rect
  value: string
  /** Radio only: this button's on-state, read from /AS. NOT getValue(). */
  state: string | null
  options: string[]
  readOnly: boolean
  required: boolean
  multiline: boolean
  maxLength: number | null
}
```

`rect` comes from `getBounds()`, which findings 12 §4 measured as Convention A across `/Rotate`
0/90/180/270 and an offset CropBox. No conversion — the overlay already works in that space.

`state` exists because of findings 12 §3: **`getValue()` on a radio kid returns the group's value,
not the button's.** Every kid in a group reports the selected option. A UI that renders "checked"
from `getValue()` shows every option in the group as chosen. The button's own state is `/AS`, read
from the raw annotation object.

Results are cached per `(sourceId, sourceIndex)` in the store. Enumerating fields means loading a
page, and scrolling a 40-page form must not re-enumerate on every scroll tick.

## 3. Filling — DOM inputs, not painted boxes

Real `<input>`, `<textarea>`, and `<select>` elements positioned over the widget rects in Layer 3.
The spec calls for this and it is right: keyboard navigation, mobile keyboards, autofill, screen
readers, and IME all work because they are the platform's own controls, and none of them would work
against a canvas-painted imitation.

`FieldLayer.vue` renders one control per `SourceField`, positioned by the same page transform the
object overlay uses. Typing writes `setFieldValue(key, value)` — one op, one undo entry, coalesced
per field so that typing a name is one undo rather than eleven.

Three details that decide whether this feels real:

- **A field is not an object.** `FieldLayer` sits below `ObjectLayer` in the stack and does not
  participate in selection, drag, or the inspector. Clicking a field focuses it; it never selects.
- **The rendered page already shows the field's original appearance**, including any value the file
  shipped with. The DOM control must therefore cover it opaquely, or the two show through each other
  — an off-by-a-pixel double image that reads as a rendering bug.
- **Read-only fields render disabled**, not hidden. A greyed control says "this exists and you may
  not change it"; omitting it says "there is nothing here", which is a different and false claim.

## 4. Creating — one tool, six types

A single **Form field** tool in the rail whose type is chosen in the inspector, rather than six rail
entries. The rail is already fifteen tools, and six more would make forms the visually dominant
feature of a product where they are one phase of eight.

Drag a rect, get a text field. Change the type in the inspector. Everything else is properties.

**Radio groups are the exception**, because a radio button alone is meaningless. Drawing with the
type set to radio adds a button to the *current group*, creating one if none exists. The inspector
shows the group's buttons as a list, with the export value of each. This mirrors the format: one
parent field, N kid widgets.

## 5. Writing — `objects/field.ts`

One-time document wiring, then per-object work.

```
ensureAcroForm(raw) -> PDFObject   // idempotent; returns the /AcroForm dict
```

Creates `/AcroForm` with `/Fields`, a `/DA` default appearance, and a `/DR` resource dictionary
carrying Helvetica — about 20 lines, measured in Phase 0. Idempotent because a source document may
already have an `/AcroForm`, and clobbering it would destroy every field already in the user's file.

Then per field type. Text, checkbox, dropdown, and listbox are ~9 lines each of raw object work, as
Phase 0 measured. Two carry real weight:

**Radio.** The parent field holds `/FT /Btn`, `/Ff` with `BTN_FIELD_IS_RADIO` (32768) and
`BTN_FIELD_IS_NO_TOGGLE_TO_OFF` (16384), `/T`, `/V`, and `/Kids`. Each kid is a widget with
`/Parent`, `/Rect`, `/AS`, and — **this is the finding** — an explicit `/AP /N` dictionary whose two
keys are the button's own export value and `Off`.

Findings 12 §1 measured what happens without it: mupdf derives a kid's on-state name from its
`/AP /N` keys, so kids with no `/AP` all fall back to `Yes`, and three buttons sharing an on-state
name are one button. Toggling any of them turns on all of them. Nothing throws. The spec's
inference — that radios would get free appearance streams like checkboxes — was wrong, which is
exactly why it mandated the spike.

So `fieldAppearance.ts` generates the two streams: a filled dot for the on state, an empty form for
off, both `/Subtype /Form` XObjects with a BBox matching the widget. Checkboxes get the same
treatment for consistency, even though mupdf would generate theirs, because one appearance path is
easier to reason about than two and the cost is a dozen lines.

**Signature box.** `/FT /Sig` with no value. This is a *place for* a signature, not a signature —
get-margin does not do cryptographic signing, and a field that looked like it did would be a
meaningful lie. The inspector says so.

Field creation runs in the same page loop as every other writer, so ordering, progress reporting,
and error naming come for free.

## 6. Applying filled values

After the object writers, before save: for each `fieldValues` entry, find the widget by name and set
it. Uses `setTextValue` / `setChoiceValue` / `toggle` where the API allows, and raw `/V` + `/AS`
where it does not.

Ordering matters. Fills run last so that a value set on a field the user *created* in this same
session works — the field must exist before it can be filled.

A key with no matching field is skipped silently, not thrown. It means a page was deleted after a
field on it was filled, which is an ordinary sequence of edits and not an error.

## 7. Tab order

Page `/Annots` array order is tab order; `/Tabs /R` on the page dictionary tells viewers to honour
it. The inspector shows a reorderable list of the page's fields, reusing `useDragReorder` from Phase
3 rather than growing a second drag implementation.

Stored as `tabOrder: string[]` per page in the edit document — field keys in order. Absent means
document order, which is what every existing file already means.

## 8. Flatten on export

`flattenForms: true` calls `raw.bake(false, true)` immediately before `saveToBuffer`.

Findings 12 §7 measured the two arguments as independent: `bake(false, true)` flattens form fields
into page content — value visible in the page text, `/AcroForm` removed — while leaving ink and
markup annotations editable. That is precisely the semantic split the project already commits to,
for one call instead of a hand-written appearance walker.

It runs on the assembled export copy, never on the document being edited: `bake` removes `/AcroForm`
wholesale and is not undoable.

The checkbox lives in the download flow and is off by default. Flattening is a one-way door — the
fields are gone from the exported file, and a user who wanted a fillable form back has to redo the
work — so the default has to be the reversible one.

## 9. Interaction with the sanitizer

Phase 4's `stripActiveContent` removes `/AA` from every annotation and forbidden `/A` chains,
`/SubmitForm` among them. A source document's field validation and calculation scripts therefore do
not survive export, which the download notice already states.

This is unchanged by this phase, and worth restating: **get-margin produces forms that hold values,
not forms that compute.** A field created here has no script and never will. Calculated fields are
not on any roadmap.

Fields the app creates are written *after* stripping runs, so they are never subject to it.

## 10. Testing

Node tests over the write path, as every phase has done — the export is the product, and it is fully
testable without a browser.

- Every field type round-trips: create, save, reopen, `getWidgets()` reports the right type, name,
  and flags. Findings 12 §5 measured that this **requires** the save/reopen — raw-object widgets are
  invisible to `getWidgets()` on a live document, so a test that asserts immediately reads zero and
  looks like a creation failure.
- Radio exclusion: toggle one kid, save, reopen, assert `/AS` is `[Off, x, Off]`. Asserted on `/AS`,
  never `getValue()`, per findings 12 §3.
- A checkbox's unchecked state renders visibly — Phase 0's `/MK /BC` finding, still a live trap.
- Geometry: a field written on `/Rotate` 90/180/270 and on an offset-CropBox page lands where it
  should, via the same golden-image approach Phase 2 used for objects.
- Filling an existing field does not disturb the rest of the document.
- `flattenForms` removes the widgets, keeps the values in page text, and leaves ink alone.
- An untouched form document still exports byte-identically.

Component tests for the fill overlay, and e2e for the round trip a user actually performs: open a
form, type, download, confirm the value is in the exported bytes.

## 11. Out of scope, stated

- **Cryptographic signing.** A signature *field* is a place for a signature. Signing is not in this
  product.
- **Calculated and validated fields.** See §9.
- **XFA forms.** A different, Adobe-proprietary form model sharing almost nothing with AcroForm.
  Files carrying it get their AcroForm half edited and their XFA half ignored, which is what every
  non-Adobe tool does.
- **Barcode and rich-text fields.**
- **Importing or exporting FDF and XFDF.**
