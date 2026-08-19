# Phase 5 pre-flight — the radio-group spike, and three things it found on the way

`PLAN.md` §7 makes this spike a condition of the phase estimate:

> a half-day radio-group mini-spike at the start of the phase (untested parent/kid `/T`+`/AS`
> semantics)

The spec inferred radio groups would behave like the checkbox case Phase 0 measured. **They do not**,
and the difference is the one that would have been discovered late and expensively.

## 1. Radio kids get no auto-generated `/AP` — and the failure is silent

Phase 0 measured that mupdf "auto-generates real `/AP` appearance streams for every type, including
two-state checkbox appearances — the fiddly part nobody had to hand-build". That is true for a
standalone checkbox. It is **not** true for radio kids under a parent field.

Built a parent `/FT /Btn` with the radio flag and three kids carrying `/AS /Off`, `/MK /BC`, and no
`/AP`. On reopen:

```
widgets found: 3   type=radiobutton  radio=true  name="choice"  flags=49152
kid0: NO /AP
toggle() -> 1
after toggle: parent /V="Yes"   /AS=[Yes, Yes, Yes]
```

Every kid turned on at once. mupdf derives a kid's on-state name from **the keys of its `/AP /N`
dictionary**; with no `/AP` there is no name to derive, so all three fell back to `Yes` — and three
kids sharing one on-state name are, as far as the format is concerned, the same button.

Nothing threw. The document is structurally valid. It is just wrong, and wrong in a way you only see
by looking.

## 2. With explicit per-kid state names it works, and survives a round-trip

Give each kid an `/AP /N << /<state> <stream> /Off <stream> >>` whose state name is unique within the
group:

```
kid0 AP /N states: alpha,Off      kid1 AP /N states: beta,Off
toggle() -> 1
after toggle: parent /V="beta"   /AS=[Off, beta, Off]
after save + reload: /AS=["Off","beta","Off"]   exactly-one-on: true
```

Mutual exclusion is correct and persists. The cost is an appearance-stream generator for the two
states — a filled dot and an empty box, ~15 lines — which the checkbox path got for free. Bounded,
now measured, and the three-week estimate holds.

## 3. `getValue()` on a radio kid returns the group's value, not the kid's

All three kids report `"beta"` after the toggle above. That is correct PDF semantics — the value
lives on the parent field — but it means **"is this button the selected one" cannot be answered with
`getValue()`**. It is `/AS`. A UI that renders selection from `getValue()` shows every option in a
group as chosen, which is exactly the bug in §1 wearing different clothes.

## 4. Widget rects are Convention B; `getBounds()` is Convention A

The hazard this project keeps re-learning. A form overlay is DOM inputs positioned over a rendered
page, so getting this wrong misplaces every field — and only on rotated or offset-CropBox pages,
which is to say not on the fixture anyone tests with first.

Wrote `/Rect [10, 20, 110, 45]` on every page of three fixtures and read `getBounds()` back:

| Fixture | `/Rotate` | Page bounds | `getBounds()` |
|---|---|---|---|
| `simple-text` p0 | 0 | 612×792 | `[10, 747, 110, 772]` |
| `rotated` p1 | 90 | 792×612 | `[20, 10, 45, 110]` |
| `rotated` p2 | 180 | 612×792 | `[502, 20, 602, 45]` |
| `rotated` p3 | 270 | 792×612 | `[747, 502, 772, 602]` |
| `offset-cropbox` p0 | 0 | 350×420 | `[-40, 455, 60, 480]` |

`792 - 45 = 747` and `792 - 20 = 772`: top-down. Rotation applied. And the offset-CropBox page puts
the rect at **negative x, and y past the page height** — outside the visible box entirely, because
`getBounds()` normalises the CropBox origin and a raw `/Rect` does not.

So widget rects are **raw PDF user space (Convention B)** and `getBounds()` reports **MuPDF page
space (Convention A)**.

> **Correction, added when Task 67's tests caught it.** The first version of this section concluded
> that writing a widget rect should go through `toAnnotSpace()`, alongside `setRect` and
> `createLink`. That is wrong, and the measurement above says so: `getBounds()` converts B to A on
> the way *out*, and **nothing converts on the way in**. Convention A belongs to mupdf's *setters*,
> which flip y and normalise the CropBox for the caller. Writing `/Rect` as a raw PDF object bypasses
> all of that and lands in the file exactly as given, so it must be given the file's own space —
> `toContentSpace`, the identity.
>
> The distinction is not annotation-versus-content. It is **setter-versus-raw-object**, and this is
> the first place in the codebase that writes an annotation rect as a raw object.
>
> Worth recording how it was caught: passing Convention A put a field meant for the bottom of the
> page at the top, which is still *inside* the page box. Three of four rotations passed a containment
> assertion. Only `/Rotate 270`, where the error pushed the rect to negative y, failed — and the fix
> was to assert the exact expected bounds rather than containment.

Reading a rect for the DOM overlay uses `getBounds()`, which is already the space the renderer works
in. That half was right.

## 5. Raw-object widgets are invisible to `getWidgets()` until save and reopen

```
getWidgets(): live=0   afterReopen=1
```

Consistent across all six pages tested. mupdf builds its widget list when the document loads and
does not rebuild it when `/AcroForm /Fields` is mutated underneath. Harmless for this architecture —
the app records ops and replays them into a fresh document rather than mutating a live one — but any
test that creates a field and immediately asserts on `getWidgets()` will read zero and look like a
creation failure.

## 6. Flag values, read off the build rather than from a table

```
BTN_FIELD_IS_RADIO            32768
BTN_FIELD_IS_NO_TOGGLE_TO_OFF 16384
BTN_FIELD_IS_RADIOS_IN_UNISON 33554432
FIELD_IS_READ_ONLY                1
FIELD_IS_REQUIRED                 2
```

`PDFWidget.setName()` is typed as taking no arguments, and there is no `setFieldFlags`. Field
*properties* — name, flags, options, max length — have no setter API at all, so the properties panel
is raw object work, as the spec anticipated for creation.

## 7. Flatten-on-export: `bake(bakeAnnots, bakeWidgets)` takes the two separately

Not in the spec, and it settles a design question the phase would otherwise have to solve by hand.
A document carrying one ink annotation and one filled text field:

```
BEFORE                              annots=1  widgets=1
bake(annots=false, widgets=true) ->  annots=1  widgets=0   value in page text: true   /AcroForm gone: true
bake(annots=true,  widgets=true) ->  annots=0  widgets=0   value in page text: true   /AcroForm gone: true
```

`bake(false, true)` flattens form fields into page content while leaving ink and markup annotations
editable — which is exactly the semantic split the project already commits to (spec §0). Flatten-form
-on-export is one call, not a hand-written appearance walker.

Note it removes `/AcroForm` wholesale, so it is an export-time operation on the assembled copy and
must never touch the document being edited.

## What this changes

Nothing in the phase's scope. Radio groups cost an appearance generator the spec did not budget for,
flatten costs less than budgeted, and the geometry answer was already in the codebase. The estimate
holds.

The one thing to carry forward: **`getValue()` is the group's, `/AS` is the button's.** Every other
finding here fails loudly. That one fails by rendering a plausible, wrong UI.
