# Findings: raw PDF object access (form widgets and content streams)

> **Note:** `spikes/…` paths referenced below were throwaway probe scripts, deleted with Phase 0
> (commit `e5bdcc3`) and never committed. The durable regression proofs are
> `packages/transform/test/transform.test.ts` (MuPDF matrix cross-check),
> `packages/pdf-core/test/render.test.ts` (rotation/layout agreement, premultiplied compositing)
> and `docs/findings/evidence/`.

Spike task 6 of Phase 0. Probes: `spikes/11-widgets.ts`, `spikes/12-content-stream.ts`,
`spikes/13-builtin-redaction.ts` (bonus — see Q6). Run logs and intermediate artifacts under
`docs/findings/scratch/` (gitignored, not committed; regenerate by re-running the probes).
Evidence PDFs/PNGs from the probes are committed under `spikes/out-*`.

mupdf is 1.28.0. `packages/pdf-core/node_modules/mupdf/dist/mupdf.d.ts` was read directly and
used as ground truth before writing any probe code — see the "API drift vs. brief" section.

## Q1 — Raw object API

**Available, all confirmed as `function` by direct introspection** (`spikes/11-widgets.ts`,
"Q1" sections; log: run the probe, see below for output):

- `PDFDocument`: `newDictionary`, `newArray`, `newName`, `newString`, `newInteger`, `newReal`,
  `newBoolean`, `newNull`, `addObject`, `addStream`, `addRawStream`, `getTrailer` — all present.
- `PDFObject` instance: `get`, `put`, `delete`, `push`, `isNull`, `isArray`, `isDictionary`,
  `isStream`, `isName`, `isNumber`, `asJS` — all present.

`PDFObject.get()` never returns `undefined` for a missing key — confirmed directly: probing
`root.get('AcroForm')` on a fixture with no AcroForm returned an object with `isNull() === true`,
not `undefined`. The probe uses `if (acro.isNull())` (not `if (!acro)`), which correctly detected
and handled the absent key. Matches engine-facts; the brief's `if (!acro || ...)` pattern would
have been dead code.

## Q2/Q3 — Form field creation from scratch

**Field dict assembled: YES**, for three field types in one document: `/Tx` (text), `/Btn`
(checkbox), `/Ch` (combo box). All three succeeded on the first structurally-correct attempt.

**AcroForm wiring required** (`spikes/11-widgets.ts` lines 82–116): create `/AcroForm` if
`root.get('AcroForm').isNull()`, set `/Fields` to a `newArray()` with each field object pushed,
`/DA` (document-level default appearance), `/NeedAppearances = true`, and a `/DR` (default
resources) dictionary containing a `/Font/Helv` entry — without `/DR`, viewers cannot resolve the
`/Helv` name referenced by each field's own `/DA`. This is exactly what the brief predicted, and
it was needed — no other missing piece surfaced.

**Auto-generated appearance streams — the standout finding.** After `annot.update()`, *all three*
field types got a real `/AP` dictionary from mupdf itself, not just a bare field dict:

```
Tx field:       AP after update(): present
Btn checkbox:   AP after update(): present   (both /Off and /Yes states — see below)
Ch combo:       AP after update(): present
```

For the checkbox specifically, the generated `AP/N` is a genuine two-state sub-dictionary:

```
AP/N: <</Off 11 0 R/Yes 13 0 R>>
  Off: "q\n1 w\nQ\n"                                    (BBox [0,0,18,18] — stroke width set, nothing drawn)
  Yes: "q\n1 w\nBT\n0 g\n2.8 3.6 Td\n/ZaDb 18 Tf\n(3) Tj\nET\nQ\n"   (draws a ZapfDingbats checkmark glyph)
```

This means the earlier engine-facts note ("auto-`/AP` confirmed for all types tested except
Link — Widget was not tested") was incomplete for Widget/checkbox specifically; it now is tested,
and it also produces auto-`/AP`.

**Rendering confirms this is real, not just structurally present** — both mupdf's own `toPixmap`
and Apple's CoreGraphics (`qlmanage -t`) render the text-field value `"hello"` and the combo-box
value `"Alpha"` as actual glyphs at the correct page-space position (see
`spikes/out-widget-mupdf-render.png` vs. `docs/findings/scratch/ql/out-widget.pdf.png` — visually
identical, no cross-renderer disagreement).

**One real nuance, caught by rendering, not by reading the API:** the *unchecked* checkbox is
invisible in both renderers — the auto-generated `Off` appearance stream sets a line width but
draws no path, and no `/MK` (appearance-characteristics: border/background colour) was supplied,
so there is nothing to see. This is not a bug — it is the correct PDF-spec behaviour for a box
with no border colour. Confirmed the fix: setting `/MK/BC` (black) and `/AS = /Yes` and
re-rendering (`docs/findings/scratch/render-checkbox-checked.ts`, not committed — evidence is the
committed logic in `spikes/11-widgets.ts` plus this description; the derived PNG showed a crisp
black-bordered box with a checkmark). **Consequence for Phase 5: every checkbox/radio field needs
an explicit `/MK/BC` (or equivalent) or it will be structurally correct but invisible when
unchecked** — a real gap the brief's checklist didn't mention.

**Interactive in Acrobat: NOT VERIFIED — requires human check.**
**Interactive in Chrome: NOT VERIFIED — requires human check.**
Neither application is available in this environment; no claim is made about either. What *was*
verified programmatically, as the closest available proxy: `spikes/out-widget.pdf` was saved,
closed, and **reopened as a fresh document**, and `page.getWidgets()` correctly re-discovered all
three fields with the right type/name/value/rect/options (full output under Q4). That confirms
the on-disk PDF structure round-trips correctly through mupdf's own parser — it does not confirm
any particular viewer's forms engine will treat it as interactive.

**Effort observed, lines of actual logic (excluding console.log/comments), for `spikes/11-widgets.ts`:**

- One `/Tx` field, given AcroForm/DR already exist: `createAnnotation('Widget')` + `setRect` +
  `getObject()` + 5× `put()` + `update()` — **9 lines**.
- Shared one-time `/AcroForm` + `/DR` document wiring (paid once per document, not per field):
  **~20 lines**.
- First field in a document: **~29 lines**. Each additional field of a similar type: **~9–15
  lines** (checkbox needed 2 extra lines for `/AS`; combo needed ~6 extra lines for the `/Opt`
  array).

## Q4 — Reading existing widgets

`page.getWidgets()` on the pristine `simple-text` fixture (no AcroForm) returned `0` widgets —
confirms the call shape on empty data, per the brief's caveat.

On the **populated, reopened** `out-widget.pdf`:

```
getWidgets() -> 3 widgets
  [text] name=probe_text_field value="hello" rect=[72,500,320,524] readOnly=false
  [checkbox] name=probe_checkbox value="Off" rect=[72,460,90,478] readOnly=false
  [combobox] name=probe_combo value="Alpha" rect=[72,420,220,442] readOnly=false
    options: ["Alpha","Beta","Gamma"]
```

`getFieldType()`/name/value/rect/read-only/options are **all exposed and correct**. One drift
worth flagging for whoever builds on this: `getFieldType()` returns lower-case, human-readable
strings (`'text'`, `'checkbox'`, `'combobox'`, `'listbox'`, `'radiobutton'`, `'button'`,
`'signature'`, `'widget'` — the full `PDFWidget.WIDGET_TYPES` list), **not** the raw PDF `/FT`
abbreviations (`Tx`, `Btn`, `Ch`) and **not** `'choice'` as a generic catch-all. The brief's own
probe sketch checked `type === 'choice'`, which is wrong for this API and would have silently
skipped every combo/list box's options dump — caught here by actually running it and getting an
empty options list until the check was corrected to `'combobox' || 'listbox'`.

## Q5 — Content stream read/modify/write

**Readable: YES · Writable: YES.**

`page.getObject().get('Contents')` on the `simple-text` fixture is an **array** of length 1
(`isArray() === true`); the single part's `readStream()`/`writeStream()` worked directly.
`Contents.isStream()` was `false` for the array itself (as expected — the array holds stream
refs, it isn't one). The brief's array-vs-single-stream branch was exercised on the array side
only; a genuinely multi-part `Contents` array was not available in any fixture and was not
constructed — **untested**: whether concatenation-order assumptions hold across >1 real part.

**Compressed/filtered streams need manual decode: NO — confirmed, not assumed.** The fixture's
content stream carries `/Filter /FlateDecode` (confirmed by reading the raw dict entry).
Measured directly:

```
Filter on part0: /FlateDecode
readRawStream length: 221   readStream length: 393   same bytes? false
```

`readStream()` transparently returns the **decompressed** 393 bytes; `readRawStream()` returns
the raw 221 compressed bytes. After patching the decoded text and calling
`writeStream(newBytes)` + `saveToBuffer('compress')`, the **reopened, saved file's** stream still
carries `/Filter /FlateDecode` — mupdf re-compressed it on save without any manual Flate work on
our part. This fully resolves the brief's open question: no manual decode/encode step is needed
anywhere in this path.

## Q6 — Locating text operators

**On the real fixture:**

```
[naive literal-only regex, "(...)  Tj"]  found 0 Tj operators
[corrected regex, literal-OR-hex]        found 2 Tj and 0 TJ operators
```

**The fixture uses hex-string operands (`<48656C6C6F...> Tj`), not literal parenthesized
strings.** The brief's exact regex (`/\((?:[^()\\]|\\.)*\)\s*Tj/g`) finds **zero** matches on real
output from this generator — a genuine, reproduced failure of the brief's assumption, not a
hypothetical. A corrected regex handling both literal and hex-string operands was required and
is what the rest of the probe uses.

**Regex approach sufficient: PARTIALLY.** A regex handling both string forms correctly located
and removed the target run in the real fixture (see Q6 decisive check below), and correctly
handles simple cases with escaped characters:

```
[escaped parens inside literal string]   input: (a \(nested\) string) Tj      -> 1 match, correct
[escaped backslash then paren]           input: (back\\) Tj (real end) Tj     -> 2 matches, correct
[TJ array with kerning numbers]          input: [(Hello) -20 (world)] TJ      -> 1 match, correct
[two Tj on one line]                     input: (One) Tj (Two) Tj             -> 2 matches, correct
```

But it **breaks on a realistic adversarial case**: a `TJ` array whose string operand contains a
literal `]` character (legal PDF, since `]` needs no escaping inside a literal string):

```
[TJ array containing a literal ] inside a string]
  input: [(a]b) -5 (c)] TJ
  TJ matches: []          <- FALSE NEGATIVE, the whole array is silently missed
```

A character-class regex cannot distinguish a `]` that closes the array from one that is data
inside a nested string, because it isn't tracking string-literal state. **A real tokenizer (a
small state machine that knows it's inside a literal/hex string vs. array vs. bare operators) is
needed for production-grade robustness**, not a regex, if the implementation strategy is
"locate-and-patch the content stream directly." (See Q6 decisive check and Phase 6 estimate below
for why this matters less than it would otherwise: mupdf ships a better primitive for this.)

### Q6 decisive check — genuinely gone, not just invisible

Patched out the second `Tj` run (`"Second line of body text for span extraction."`) by
overwriting it in place with spaces (byte-length preserving), wrote `spikes/out-patched.pdf`,
then **closed the document, reopened it fresh from disk**, and re-ran
`toStructuredText().asJSON()`:

```
--- Text extraction AFTER patch, from a freshly reopened doc ---
"Hello margin"

contains "Second line of body text"? false
other text still present ("Hello margin")? true
```

**Text genuinely unextractable after patch: YES.** This is the strongest possible check available
in this environment — a fresh document object, not the live one still holding the edit in memory.
`pdftotext` was not available in this environment to cross-check with a third extractor; mupdf's
own re-extraction from a cold reopen is what's committed and is what the claim above rests on.

Rendering also confirms the rest of the page is undamaged: `spikes/out-patched-mupdf-render.png`
and `docs/findings/scratch/ql2/out-patched.pdf.png` (mupdf and CoreGraphics respectively) are
visually identical — title text and the coloured rectangle both intact, only the targeted line is
gone. **No cross-renderer disagreement.**

### Bonus finding — mupdf ships a built-in redaction primitive (`spikes/13-builtin-redaction.ts`)

Not asked for by the brief, but directly relevant to Q6/Phase 6: `mupdf.d.ts` exposes
`PDFPage.applyRedactions(black_boxes?, image_method?, line_art_method?, text_method?)` plus a
`'Redact'` annotation type with `REDACT_TEXT_REMOVE`/`REDACT_TEXT_NONE` constants. Tested it
end-to-end:

1. `page.createAnnotation('Redact')`, `setRect` **and** `setQuadPoints` over the target line's
   bounding box (page-space, from `toStructuredText().asJSON()`'s line `bbox`), `annot.update()`.
2. `page.applyRedactions(true, REDACT_IMAGE_NONE, REDACT_LINE_ART_NONE, REDACT_TEXT_REMOVE)`.
3. Save, **reopen fresh**, re-extract.

```
extracted text from fresh reopen: "Hello margin"
contains "Second line of body text"? false
other text still present ("Hello margin")? true
```

Genuine removal, confirmed the same way as the manual-patch check, plus a black box was
auto-drawn over the region (`spikes/out-builtin-redact-render.png`, cross-checked against
CoreGraphics in `docs/findings/scratch/ql3/`, no disagreement). **Two real mistakes made and
corrected while getting here, both left visible in the probe's comments as evidence:**

- First attempt used the raw content-stream `Tm` y-coordinate (660, bottom-up PDF space) directly
  as the page-space rect for the Redact annotation. Wrong space — the black box landed near the
  *bottom* of the page while the real text is near the *top*. Fixed by using the bbox that
  `toStructuredText().asJSON()` already reports in page-space (`{x:72, y:120, w:214, h:15}`).
- `applyRedactions()` did nothing with only `setRect()` set — `hasQuadPoints()` is `true` for
  `Redact`, and it turns out the redaction region is driven by `/QuadPoints`, not `/Rect`. Fixed
  by also calling `setQuadPoints()`.

**This changes the practical recommendation for Phase 6, not just the estimate** — see below.

## PHASE 5 ESTIMATE

Spec allots 3 weeks for six field types plus radio-group parent/kid semantics.

**CONFIRM 3 weeks**, with reasoning:

- Three of six field types (text, checkbox, combo box) were built from scratch, wired into a
  working `/AcroForm`, and verified to round-trip correctly through save/reload — in well under a
  day, with no dead ends, no undocumented API gaps, and no crashes. Per-field marginal cost is
  small (9–15 lines) once the one-time AcroForm/DR wiring exists.
- mupdf auto-generates real `/AP` appearance streams for every field type tried, including
  multi-state checkbox appearances — this removes what could otherwise be the single largest
  Phase 5 cost (hand-building appearance streams per field type).
- **What is NOT retired by this spike, and is the reason not to revise downward:**
  - **Radio-group parent/kid hierarchy is untested.** Structurally it's "more of the same
    pattern" (a non-terminal parent field dict plus multiple kid `Widget` annotations sharing the
    parent's `/T`, each kid's own `/AP` keyed by the shared export values, `/AS` set per kid), and
    nothing observed here suggests it would behave differently from the checkbox case — but that
    is an inference, not a measurement. Recommend a half-day mini-spike at the start of Phase 5
    specifically for radio groups before committing to the 3-week estimate holding.
  - **Interactive behaviour in Acrobat and Chrome is completely unverified.** Everything above is
    strong structural and cross-renderer-visual evidence, but the spec's actual bar ("does typing
    in the field work") cannot be checked in this environment. This should be a hard checkpoint
    before Phase 5 is considered done, not an assumption carried into later phases.
  - The `/MK` border-visibility gap (checkboxes render blank without it) is a small but real
    detail that needs to be part of every button-type field builder, not just discovered per-bug
    later.

## PHASE 6 ESTIMATE

Spec allots ~1.5 weeks for text patching.

**REVISE the implementation approach, tentatively REVISE DOWN the estimate to ~1 week** —
contingent on adopting `PDFPage.applyRedactions()` as the primary mechanism instead of hand-rolled
content-stream regex/tokenizer surgery.

Reasoning:

- The manual regex-patch path works for the simple case and was proven to genuinely remove text
  (not just visually cover it) — but the same probe also proved a naive regex is **not** robust
  against realistic PDF content (a literal `]` inside a `TJ` string operand defeats it silently).
  Building this correctly by hand means writing an actual tokenizer, which is real, non-trivial
  work — this is the scenario the original 1.5-week estimate was presumably sized for.
- `applyRedactions()` **already does the hard part** — it is mupdf's own content-stream-aware
  redaction engine, confirmed to genuinely strip text (verified by the same freshly-reopened-doc
  re-extraction check used for the manual path) with a ~10-line call, no tokenizer needed, and it
  transparently handles FlateDecode-compressed streams (confirmed above) without any manual
  decode work.
- It fits the product's natural workflow well: the region to redact is expressed as a page-space
  quad, and a page-space bbox per text line/span is exactly what `toStructuredText().asJSON()`
  already provides (needed anyway for Phase 2 text selection) — no need to correlate a redaction
  target back to a specific `Tj`/`TJ` byte range in the content stream at all.
- Caveats that keep this from being a bigger downward revision: `applyRedactions()`'s
  `image_method`/`line_art_method` parameters (image and vector-art redaction) were deliberately
  left at `NONE` and were **not exercised** — only text removal was verified. Rotated/skewed quad
  regions were not tested. Multi-part `Contents` arrays (>1 stream) were not available in any
  fixture and were not tested with either approach.

**Cover-and-redraw viable now: YES** (this was already established by the Task 4 annotation
spike — opaque `Square`/redaction-style annotations with auto-generated `/AP` work).

**Content-stream surgery (manual, hand-rolled) viable now: NEEDS A TOKENIZER** for production
robustness — proven necessary by the literal-`]`-in-`TJ`-array failure case above. Estimate a
tokenizer at 2–3 days of focused work if this path is still wanted as a fallback or for
fine-grained partial-run redaction that `applyRedactions()`'s region-based model doesn't fit.

**Recommendation:** build Phase 6 around `applyRedactions()` + structured-text bbox selection as
the primary path; treat hand-rolled content-stream tokenization as an optional fallback, not the
default design, which is why the estimate revises down rather than up despite the regex fragility
finding.

## API drift vs. brief (mupdf 1.28.0, confirmed against `mupdf.d.ts` and by running probes)

- `PDFObject.get()` never returns `undefined`; missing keys have `isNull() === true`. Confirmed
  live (see Q1).
- `StructuredText.asJSON()` returns a **JSON string**, not a pre-parsed object — every probe here
  calls `JSON.parse(st.asJSON())`. The brief's phrasing (`toStructuredText().asJSON()`) doesn't
  make this explicit.
- `PDFWidget.getFieldType()` returns lower-case descriptive strings (`'text'`, `'checkbox'`,
  `'combobox'`, `'listbox'`, `'radiobutton'`, `'button'`, `'signature'`, `'widget'`), not the raw
  `/FT` PDF names and not `'choice'`. The brief's own sketch used `'choice'`, which does not
  match any value `PDFWidget.WIDGET_TYPES` can produce.
- `PDFAnnotation.setRect()`/`setQuadPoints()` take page-space, top-down coordinates — this was
  already settled by the Task 4 spike, and this spike's own first attempt at `applyRedactions()`
  re-derived the same lesson the hard way by using raw content-stream `Tm` coordinates instead
  and getting a visibly misplaced black box, corrected using a coordinate source
  (`toStructuredText().asJSON()`) that is already in page-space.
- `PDFAnnotation.setQuadPoints()` takes an **array of `Quad`**, where `Quad` is itself an
  8-number tuple (`[x0,y0,x1,y1,x2,y2,x3,y3]`) — i.e. `setQuadPoints([[...]])`, not
  `setQuadPoints([...8 numbers...])`. Caught by a live `TypeError: expected quad` on the first
  attempt.
- `PDFObject.readStream()`/`writeStream()` (decoded) vs. `readRawStream()`/`writeRawStream()`
  (raw, filtered bytes) are both real, always-present methods — not optional per the brief's
  structural `PDFObjLike` type. `readStream()` handles `/FlateDecode` transparently on read, and
  `saveToBuffer('compress')` re-applies it transparently on write.
