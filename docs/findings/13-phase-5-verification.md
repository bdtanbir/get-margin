# Phase 5 verification — forms

Task 78. Tasks 66–77 are built. This records what is covered, what is not, and the two things the
spec makes conditions of calling the phase done.

## The pre-flight earned its place

`PLAN.md` §7 made a radio-group mini-spike a condition of the phase estimate, on the grounds that
parent/kid `/T` + `/AS` semantics were inferred from the checkbox case rather than measured. The
inference was wrong, and the phase would have shipped a silent bug without it
(`docs/findings/12-phase-5-preflight.md`).

It is worth naming what "wrong" meant, because it recurred **three times from three directions**:

1. **In the writer.** Radio kids with no `/AP` all fall back to the on-state `Yes`, so three buttons
   become one button and toggling any turns on all. Fixed by generating an explicit two-state
   appearance keyed by each button's own export value.
2. **In the reader.** `getValue()` on a kid returns the *group's* value, so all three report the
   selected option. A UI rendering "checked" from it shows every option as chosen. Fixed by carrying
   `state`, read from the raw `/AS`.
3. **In the fill path.** A group's stored value *names* the selected button, and every button shares
   one key — so treating it as "this button is on", the way a checkbox does, turns on every button.
   Same wrong document, third distinct cause.

Each has its own tests. The recurrence is the useful finding: one measurement fixed the writer, and
the same misunderstanding was waiting in two other places that looked unrelated.

## Covered, on every commit

| Area | Check | Where |
|---|---|---|
| Schema | v1 → v2 → v3 stepwise; v3 defaults change nothing about an existing document | `test/write/migrate.test.ts` |
| Text fields | Round-trip with name, value, multiline, read-only, required, max length | `test/write/field.test.ts` |
| AcroForm | Created once, and a source document's own form is extended rather than replaced | `test/write/field.test.ts` |
| Geometry | A field on `/Rotate` 0/90/180/270 and an offset CropBox lands at **exactly** the Convention A rect | `test/write/field.test.ts` |
| Buttons | Checkbox round-trips both states and carries `/MK /BC`, so unchecked is visible | `test/write/field.test.ts` |
| Radio | One parent, N kids; each kid's `/AP /N` carries its own export value; `/AS` reads `[Off, x, Off]`; exclusion survives reload; a group spans pages | `test/write/field.test.ts` |
| Choice | Options round-trip in order; combo and list box distinguished; a value outside the options is dropped | `test/write/field.test.ts` |
| Signature | `/FT /Sig` with no value, and visible when empty | `test/write/field.test.ts` |
| Reading | Every type reported with its rect, properties, and per-button state | `test/write/fields.test.ts` |
| Filling | Text, checkbox, choice, and radio-by-export-value; a stale key is ignored; the rest of the document is undisturbed | `test/write/fields.test.ts` |
| Pass-through | A fill, a flatten, or a tab order each defeat the byte-identical tier; an untouched form still exports byte for byte | `test/write/fields.test.ts`, `e2e/forms.spec.ts` |
| Flatten | Widgets gone, values in the page text, `/AcroForm` gone, **ink annotations still editable** | `test/write/fields.test.ts` |
| Tab order | `/Annots` reordered, `/Tabs /R` set, unknown names ignored, a radio button's name found on its parent | `test/write/fields.test.ts` |
| Fill overlay | One real control per field, of the right type, positioned by scaling alone; typing is one undo; read-only is disabled; emptied ≠ untouched | `test/features/FieldLayer.test.ts` |
| Radio in the UI | Exactly one button checked, ever; the export value is what gets stored | `test/features/FieldLayer.test.ts` |
| Field tool | Unique names, square buttons, consecutive radios join one group with distinct export values | `test/features/fieldTool.test.ts` |
| Properties | Per-type property sets; empty name and reserved option value refused; options added, removed, edited | `test/features/Inspector.test.ts` |
| Tab order UI | Reordering is undoable, keyboard-reachable, shows what the export will do | `test/features/TabOrderList.test.ts` |
| Flatten UI | Off by default, offered only when there is a form, undoable | `test/features/flatten.test.ts` |
| End to end | Fields render as real inputs; a filled value reaches the exported bytes; radio exclusion; created field survives export | `e2e/forms.spec.ts` |

**1033 unit tests, 67 e2e** across desktop and phone, clean `tsc`, `vue-tsc`, and build.

## Two bugs found by tests rather than by users

Both are recorded because the *way* they were found is the transferable part.

**Convention A written into a raw `/Rect`.** The pre-flight's measurement was right and the sentence
drawing a conclusion from it was wrong: `getBounds()` converts B → A on the way out, and nothing
converts on the way in. The distinction is not annotation-versus-content, which is how this codebase
had framed it; it is **setter-versus-raw-object**. Passing Convention A put a field meant for the
bottom of a page at its top — still *inside* the page box, so three of four rotations passed a
containment assertion. Only `/Rotate 270` failed. The fix was to assert exact expected bounds.

**The fill overlay was unclickable.** `FieldLayer` mounted below `data-text-surface`, which is
pointer-events-auto across the whole page under the select tool. Every field was covered; a checkbox
could not be ticked at all. Unit tests dispatch events at elements directly, and Playwright's
`fill()` focuses rather than clicks — so every text-field test written before this passed. Only
`check()`, which performs a genuine click and therefore hit-tests, found it.

The shared lesson: **an assertion that cannot distinguish the right answer from a plausible wrong one
is not a test.** Containment could not tell top from bottom; `fill()` could not tell reachable from
covered.

## Outstanding

### 1. Human verification that created fields are interactive — GATES THE PHASE

`PLAN.md` §7 names this explicitly:

> human verification that the created fields are actually interactive in Acrobat and Chrome

Nothing here can do it. The tests prove the objects are structurally correct and that MuPDF reads
them back as the right types — they cannot prove Acrobat lets someone type into one. Open
`evidence/phase-5-created-fields.pdf` and confirm: text fields accept typing, the checkbox toggles,
**the three radio buttons are mutually exclusive**, the dropdown lists its options, and Tab moves
between them in the configured order.

Generate it with the field tool over any document, one of each type, then download.

### 2. The cross-viewer and real-phone checks carried since Phase 2

Unchanged and still gating the MVP (`docs/findings/11-phase-4-verification.md`).

### 3. Smaller, recorded

- **Field appearance is minimal.** A dot for on, empty for off, a `/MK /BC` border. No custom
  colours, border styles, or check-mark glyphs. The format supports all of it; nothing here needs it
  yet.
- **`/DA` names Helvetica only.** A created field cannot use the bundled body faces. Text *objects*
  can, and do — this is a gap in field styling, not in the font pipeline.
- **Auto-size (`fontSize: 0`) is what viewers do with it**, which varies. A field with an explicit
  size is predictable; the default is not.
- **No FDF/XFDF, no XFA, no barcode or rich-text fields, no calculated or validated fields, and no
  cryptographic signing.** All stated in `PHASE-5-DESIGN.md` §11, and §9 for why scripts are absent
  by construction rather than by omission.
- **A source document's field scripts do not survive export**, because Phase 4's sanitizer removes
  them. The download notice says so. Restated here because it is the one place where two phases'
  decisions interact in a way a user could notice.
