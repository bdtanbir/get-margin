# Findings: MuPDF.js write path (annotations and font embedding)

> **Note:** `spikes/…` paths referenced below were throwaway probe scripts, deleted with Phase 0
> (commit `e5bdcc3`) and never committed. The durable regression proofs are
> `packages/transform/test/transform.test.ts` (MuPDF matrix cross-check),
> `packages/pdf-core/test/render.test.ts` (rotation/layout agreement, premultiplied compositing)
> and `docs/findings/evidence/`.

mupdf resolved to **1.28.0** (per `engine-facts.md`). `packages/pdf-core/node_modules/mupdf/dist/mupdf.d.ts`
was used as ground truth throughout; drift from the brief's `^1.26.0`-era assumptions is called
out inline.

Probes (committed at the time of the spike; deleted with `spikes/` at Phase 0 close — see the banner above). An earlier pass of this spike deleted several ad-hoc probes after folding their output into this doc; that was a mistake, corrected in this revision:
- `spikes/03-annotations.ts` — Q1/Q2 annotation matrix, `/AP` presence.
- `spikes/04-fonts.ts` — original combined font probe (kept for its own record, but see the note
  on Q5 below: it does not isolate `addSimpleFont`/`addFont`).
- `spikes/05-annot-coordspace.ts` — Q2's coordinate-space finding (`setRect`/`getRect` vs. raw
  `/Rect`, plus pixel-sampling the render).
- `spikes/06-font-subset-isolation.ts` — Q5's isolated per-call, per-font-size size deltas and
  the three-way `subsetFonts()` test.
- `spikes/07-freetext-customfont.ts` — Q3's custom-font `/DA`/`/DR` fallback test.
- `spikes/08-drawtext-measure.ts` — Q4's `Text`/`Device` render-and-measure test.
- `spikes/09-link-rect-abort.ts` — Q1's Link/`Rect` behavior, including the correction below.

TTF used: `/System/Library/Fonts/Supplemental/Arial Unicode.ttf` — exists on this machine (the
brief's exact hardcoded path), 23,278,008 bytes (22.2MB / 22,732.4KB). A second, more typical
single-script font (`Arial.ttf`, 773,236 bytes / 755.1KB) was used to confirm the size-delta
finding wasn't an artifact of the first font's unusual size.

---

## Q1 — Annotation type support

`page.createAnnotation(type)` itself **never failed** for any of the 10 types tested (confirmed
against `mupdf.PDFAnnotation.ANNOT_TYPES`, the shipped ground-truth list, which also includes all
10). The one failure is downstream: **`Link`-type `PDFAnnotation`s reject `setRect()` and
`getRect()`**. Directly called (`spikes/09-link-rect-abort.ts`): `hasRect()` returns `false` for a
fresh Link annotation, and both `getRect()` and `setRect()` throw a normal, catchable
`Error: Link annotations have no Rect property`.

**Correction from the previous revision of this doc.** That revision claimed the low-level
escape hatch — `annot.getObject().put('Rect', [...])` — "hard-aborts the WASM runtime
(`RuntimeError`, unrecoverable)". Re-running this properly, with every call individually
try/catch-wrapped, **does not reproduce that claim**: `getObject().put('Rect', [72,300,300,320])`
on a Link annotation succeeds without crashing anything (though the write is inert —
`getRect()` afterward still throws the same error, and `update()` returns `false` with no `/AP`
produced, so the low-level put doesn't actually make the annotation function as a rect-based one
either). The most likely explanation for the original "abort" is a **different, earlier line** in
the now-deleted ad-hoc probe: an *unwrapped* `link.getRect()` call, one statement before the
`put()` that got blamed. That throws the exact same catchable `Error: Link annotations have no
Rect property` — consistent with `spikes/09-link-rect-abort.ts`'s Part 3, which reproduces an
un-try/catched call in the same shape as the original probe's and captures the real stack trace.
(The deleted probe itself no longer exists to compare against directly, so this is a plausible
reconstruction, not a verified trace — the substantive claim that follows, that the low-level
`put()` succeeds and the failure is an ordinary catchable `Error`, is independently demonstrated by
the probe code above and stands on its own regardless of this historical account.)

```
Error: Link annotations have no Rect property
    at Object.6168345 (.../mupdf-wasm.js:1:4963)
    at Q (.../mupdf-wasm.js:1:3737)
    at a (.../mupdf-wasm.js:1:8841)
    at mupdf-wasm.wasm.wasm_rethrow (wasm://wasm/mupdf-wasm.wasm-...:wasm-function[36]:...)
    at mupdf-wasm.wasm.wasm_pdf_annot_rect (wasm://wasm/mupdf-wasm.wasm-...:wasm-function[4094]:...)
    at PDFAnnotation.getRect (.../mupdf.js:2603:28)
```

It is a plain `Error`, not a `WebAssembly.RuntimeError`. Node's default uncaught-exception printer
dumped the offending source file's content above the trace — and because `mupdf-wasm.js` is
emitted as one enormous single-line minified bundle, that dump looked like a wall of engine
internals, which was misread as an unrecoverable WASM-level abort. It was an ordinary, catchable,
one-line-away-from-being-caught JS exception. **This is a real category difference from the Task 3
disposal finding** (a genuine WASM heap OOM after omitted `.destroy()` calls, confirmed via RSS
measurements and an actual fatal `malloc` failure) — that one is a true hard crash; this one is
not. The corrected, narrower lesson: `getRect()`/`setRect()` on a `Link` annotation throw
ordinary, catchable errors, and low-level `PDFObject.put()` writes to a field the high-level API
disallows are silently inert rather than dangerous.

The working replacement for URI links is a **separate, non-`PDFAnnotation` API**:
`page.createLink(bbox: Rect, uri: string): Link` (the `fz_link` class, not `pdf_annot`). This is
not mentioned anywhere in the brief. It worked immediately: `getURI()` round-tripped the exact
string. `fz_link` objects have no `/AP` / appearance-stream concept — they're invisible clickable
hotspots by design (matches PDF spec: `/Link` annotations normally render nothing themselves).

| Type | `createAnnotation` | mupdf render | `/AP` present | CoreGraphics render | Acrobat | Chrome |
|---|---|---|---|---|---|---|
| Highlight | OK | YES — yellow rounded highlight bar, correct position/color | YES (`<</N n 0 R>>`) | YES — pixel-identical to mupdf render | NOT VERIFIED — requires human check | NOT VERIFIED — requires human check |
| Underline | OK | YES — red line at bottom of quad | YES | YES — identical | NOT VERIFIED | NOT VERIFIED |
| StrikeOut | OK | YES — purple line through quad middle | YES | YES — identical | NOT VERIFIED | NOT VERIFIED |
| Ink | OK | YES — black zigzag stroke matching ink points | YES | YES — identical | NOT VERIFIED | NOT VERIFIED |
| FreeText | OK | YES — blue Helvetica text, correct contents/size/color | YES | YES — identical | NOT VERIFIED | NOT VERIFIED |
| Square | OK | YES — red-bordered, pink-filled rect | YES | YES — identical | NOT VERIFIED | NOT VERIFIED |
| Circle | OK | YES — green-bordered ellipse | YES | YES — identical | NOT VERIFIED | NOT VERIFIED |
| Line | OK | YES — blue 3pt line | YES | YES — identical | NOT VERIFIED | NOT VERIFIED |
| Link | OK (annotation created) | **N/A — `setRect()` fails, never reaches `update()`** | N/A | N/A | NOT VERIFIED | NOT VERIFIED |
| Stamp | OK | YES — red "DRAFT" rubber-stamp box (MuPDF's own default icon; I set no icon/contents) | YES | YES — identical | NOT VERIFIED | NOT VERIFIED |

Evidence: `docs/findings/evidence/out-annots-mupdf-render.png` (mupdf's own `toPixmap` render of
the saved+reloaded PDF) and `docs/findings/evidence/out-annots-coregraphics-render.png`
(`qlmanage -t`, CoreGraphics/Quick Look — the same engine Preview uses, run headlessly). Both were
visually inspected directly; they are indistinguishable in layout, color, and content for every
working annotation type. **No cross-renderer disagreement was found for any type.** These three
files (plus `docs/findings/evidence/out-annots.pdf`, the saved+reloaded PDF itself) were moved out
of the now-deleted `spikes/` directory at Task 11 specifically because they are the only artifacts
that let a human perform the still-outstanding Acrobat/Chrome verification — see the decision
record's "Blocking issues for Phase 1" for that open item.

Acrobat and Chrome were **not opened** — this environment has no GUI. Any claim about them would
be fabricated; they are marked `NOT VERIFIED — requires human check`, not inferred as passing.

## Q2 — Appearance streams

**Auto-generated by `update()`: YES**, for every type except Link (which never gets that far).
Confirmed programmatically (not just by rendering): after `setXxx(...)` + `update()`,
`annot.getObject().get('AP')` is a non-null dictionary (`isDictionary() === true`,
`<</N n 0 R>>`) for all 9 working types.

**Cross-viewer consistent: YES**, between the two renderers actually available in this
environment (mupdf itself, and CoreGraphics via `qlmanage`) — no divergence observed. Acrobat and
Chrome are unverified (see table). Given the two independent engines checked agree exactly, and
given mupdf writes real `/AP` streams (not viewer-side synthesis) for every type, there is no
positive evidence of a cross-viewer risk — but this is not the same as having verified Acrobat and
Chrome, which the spec names explicitly.

**Major coordinate-system finding (measured, corrects a plan-relevant assumption):**
`PDFAnnotation.setRect()` / `setQuadPoints()` / `setLine()` / `getRect()` operate in **page space**
— top-down, y=0 at the top of the CropBox, the same convention `toPixmap`, `getBounds()`,
`getTransform()`, and `StructuredText.asJSON()` use (per `engine-facts.md`'s Task 3 findings) —
**not** the raw bottom-up PDF content-stream space that the on-disk `/Rect` dictionary entry
actually stores. Verified directly (`spikes/05-annot-coordspace.ts`, Part A — real output):

```
setRect([72, 400, 200, 460])
getRect() immediately after            -> [ 72, 400, 200, 460 ]   (same values, page-space)
getObject().get('Rect').asJS()         -> [ 71, 331, 201, 393 ]   (raw on-disk dict, bottom-up)
... after save + reload ...
getRect()                              -> [ 72, 400, 200, 460 ]   (round-trips exactly)
raw /Rect (reloaded)                   -> [ 71, 331, 201, 393 ]   (unchanged)
```

`792 − 400 = 392` and `792 − 460 = 332`, matching the observed raw y-range `[331, 393]` to within
1pt (consistent with a small border-width inflation mupdf applies on all four sides, also visible
in x: `72→71`, `200→201`). mupdf's binding transparently flips y on every get/set call.

This was cross-confirmed a second, independent way (`spikes/05-annot-coordspace.ts`, Part B — real
output): scanned `docs/findings/evidence/out-annots-mupdf-render.png` for the exact pixel rows of three
annotations (pure, unambiguous colors) and compared against two candidate formulas:

```
Blue (Line, raw y=340):               rows=[677,682]
Yellow (Highlight, raw y=710-735):    rows=[1420,1469]
Pink fill (Square, raw y=400-460):    rows=[802,917]

"unflipped" hypothesis (img_row = raw_y × 2):        Line ~680, Highlight ~1420-1470, Square ~800-920
"flipped standard" (img_row = (792-raw_y) × 2):      Line ~904, Highlight ~114-164,   Square ~664-784
```

The unflipped formula matches all three to within 1–3px; the naive PDF-spec flip is off by
120–140px in every case and is ruled out. (The row ranges above differ by a few pixels from the
first pass of this spike — `[798,921]` vs. this run's `[802,917]` for Square — because the color
match threshold in the re-created scan script is not byte-identical to the deleted original; the
conclusion is unaffected either way, since both are ~130px away from the flipped-standard
prediction and ~0px from the unflipped one.)

**Practical consequence:** `engine-facts.md`'s Task 3 statement — "`/Rect` and `/QuadPoints` live
in [bottom-up] space, not page space" — is true of the *raw on-disk dictionary value*, but **false
of what the `PDFAnnotation` setter/getter methods expose**. A future `annots.ts` should feed these
setters the output of **`pdfToView(p, geom, 1)`** — i.e. page space at **scale 1, unscaled points**,
not the zoom-scaled view pixels `pdfToView` returns for on-screen rendering — with **no manual
bottom-up flip**. Passing a zoom-scaled rect here would be silently accepted and land the
annotation at a multiple of the correct offset. Applying Task 3's read-path flip rule to these
write-path setters would also place every annotation in the wrong place (as this spike did on its
first pass, until pixel-sampled evidence caught it).

## Q3 — FreeText capability

Font size, color, and **standard (base-14) font family** all worked via
`setDefaultAppearance(fontName, size, color)`: `setDefaultAppearance('Helv', 14, [0.1, 0.2, 0.8])`
produced a correct, auto-generated `/AP` rendering 14pt blue Helvetica text matching the
`setContents()` string, confirmed in both renderers.

**Alignment**: `setQuadding(0|1|2)` (left/center/right) is accepted without error and does not
break appearance generation. I could not conclusively confirm center-alignment *visually* in this
probe — the test string was wide enough relative to its rect that left- and center-alignment would
look near-identical at a glance. This is an honest gap, not a negative result: the call succeeds
and produces a valid `/AP`, but I did not isolate a short string in a wide rect to make the
alignment difference visually unambiguous.

**Arbitrary embedded custom font: does NOT work via the high-level API.** I registered a
distinctive custom TTF (`Zapfino.ttf`, chosen because its glyphs are visually unmistakable) via
`doc.addSimpleFont(font, 'Latin')`, then called
`freeText.setDefaultAppearance('Zapfino', 20, [0,0,0])`. Real output
(`spikes/07-freetext-customfont.ts`):

```
addSimpleFont ref: 7 0 R
BaseFont entry: Zapfino
setDefaultAppearance(customFontBaseFontName) accepted, no throw
FreeText /DA: /Zapfino 20 Tf 0 0 0 rg
FreeText /DR present: false
FreeText getDefaultAppearance(): { font: 'Helv', size: 20, color: [ 0, 0, 0 ] }
```

The literal string `/Zapfino 20 Tf 0 0 0 rg` was written into `/DA`, but **no `/DR` (default
resources) dictionary was created** to resolve the name `/Zapfino` to the actual embedded font
object, and mupdf's own `getDefaultAppearance()` read back `font: 'Helv'` — its appearance-stream
generator silently fell back to a standard font rather than honoring the unresolvable custom name.
Making this work would require manually constructing the annotation's `/DR` dictionary — untested
here, judged out of spike scope (it starts to look like the manual/low-level path anyway).

**VERDICT**: `FreeText` is sufficient for the text tool **if it only needs to offer the standard
14 PDF base fonts** (Helvetica/Times/Courier family × weights, arbitrary size/color, left/center/
right alignment) — that is the ~50-line path the brief anticipated, and it is fully backed by
auto-generated, cross-renderer-consistent `/AP` streams. **If the text tool must support an
arbitrary/custom embedded font** (which Q4/Q5's DECISION implies the project needs), `FreeText`'s
ergonomic API does not get there for free — text must be drawn as content-stream operators
instead (confirmed working end-to-end below, Q4), or `FreeText`'s `/DR` would need to be built by
hand (unverified, likely non-trivial). This is the ~300-line path.

## Q4 — Arbitrary TTF embedding

**Working calls, both confirmed:**
- `new mupdf.Font(name: string, bytes: Uint8Array)` — constructs from raw bytes. Confirmed with
  the 22.2MB Arial Unicode.ttf and separately with Zapfino.ttf and Arial.ttf.
- `doc.addSimpleFont(font, encoding?: 'Latin'|'Greek'|'Cyrillic')` → `PDFObject` — OK, no error.
- `doc.addFont(font)` → `PDFObject` (composite/Identity-H, full-Unicode encoding) — OK, no error.

Both register successfully. Neither is `addFont`/`addSimpleFont` mentioned as risky in the
brief — the drift from `^1.26.0` assumptions here is minor (signatures match).

**Does text drawn with it render and measure correctly? YES — verified directly, not inferred.**
Built a `Text` object with `Text.showString(font, matrix, str)` (the Zapfino font, a 28pt string),
rendered it via `Device.fillText()` into a `DrawDevice`/`Pixmap`, and saved the PNG
(`spikes/out-drawtext-probe.png`, inspected directly — visibly renders in Zapfino's distinctive
calligraphic glyph shapes, not a fallback font). Measurement was cross-checked two independent
ways; real output from `spikes/08-drawtext-measure.ts`, and it reproduces exactly on rerun:

```
showString() returned end-matrix x-advance:                          465.9200134277344
independent sum of font.advanceGlyph(font.encodeCharacter(ch))*size:  465.91999793052673
```

This confirms the low-level `Font` + `Text` + `Device` primitives are sound: an arbitrary TTF can
be loaded, drawn, rendered, and measured correctly. What was **not** tested (judged beyond spike
scope): wiring this into an actual page content-stream edit (i.e., making the drawn text part of a
real page's visible content via `PDFDocument`, not just a standalone `Pixmap`) or into `FreeText`'s
`/DR` (see Q3). A future `write/drawText.ts` task would build on exactly this primitive.

## Q5 — Subsetting

**Automatic: NO.** `spikes/04-fonts.ts` (the original combined probe) calls `addSimpleFont` and
`addFont` sequentially on the *same* document and only measured one combined delta — it does not
isolate the two calls. That isolation is restored in `spikes/06-font-subset-isolation.ts`, which
opens a fresh document per call and measured, at two very different font sizes (real output,
reproduces exactly on rerun):

```
Arial Unicode.ttf (22,732.4KB raw):
  A) baseline, no font registered:            1.2 KB
  B) addSimpleFont ONLY, unused:          14,830.7 KB
  C) addFont ONLY, unused:                14,858.7 KB
  D) addFont + subsetFonts(), unused:     14,858.7 KB
  E) addFont (ref captured) + subsetFonts(): 14,858.7 KB

Arial.ttf (755.1KB raw):
  A) baseline, no font registered:            1.2 KB
  B) addSimpleFont ONLY, unused:            416.4 KB
  C) addFont ONLY, unused:                  432.4 KB
  D) addFont + subsetFonts(), unused:       432.4 KB
  E) addFont (ref captured) + subsetFonts(): 432.4 KB
```

| Font | Raw size | Baseline (no font) | +`addFont()`, unused | Delta | Delta as % of raw |
|---|---|---|---|---|---|
| Arial Unicode.ttf | 22,732.4KB | 1.2KB | 14,858.7KB | 14,857.5KB | 65.4% |
| Arial Unicode.ttf (`addSimpleFont` instead) | 22,732.4KB | 1.2KB | 14,830.7KB | 14,829.5KB | 65.2% |
| Arial.ttf | 755.1KB | 1.2KB | 432.4KB | 431.2KB | 57.1% |

These numbers are unchanged from the previous revision of this doc — the isolation probe
reproduces the same percentages that the probe code (deleted with `spikes/`) originally measured.

The delta is consistently 57–65% of raw TTF size regardless of font size or which `add*Font` call
is used — the signature of **plain Flate compression of the whole font program**, not glyph-level
subsetting (real subsetting of a handful of used glyphs out of a multi-thousand-glyph font would
produce a delta orders of magnitude smaller than this).

**`doc.subsetFonts()` exists** — a `PDFDocument` method not mentioned anywhere in the brief. It
was tested three ways (rows B–E above, `spikes/06-font-subset-isolation.ts`), all against a font
registered via `addFont()` but never referenced by any drawn glyph:
- `addFont()` alone: 14,858.7KB (large font) / 432.4KB (Arial.ttf)
- `addFont()` + `subsetFonts()`: **identical**, 14,858.7KB / 432.4KB
- `addFont()`, keep the returned ref, then `subsetFonts()`: **identical** again, 14,858.7KB / 432.4KB

`subsetFonts()` made **zero measurable difference** in all three cases. The most plausible
explanation is that it only prunes glyphs that are actually referenced by real content-stream
text-showing operators — exactly the situation a freshly `addFont()`'d, unused font doesn't have.
This was **not tested with the font actually drawn into page content** (would require building a
real content-stream edit — judged beyond spike scope, and is exactly the kind of test that
belongs in whichever future task implements the real font-embedding module, since getting it wrong
has direct cost implications).

**Conclusion**: registering a font for later use costs 57–65% of its raw byte size *immediately*,
with no automatic relief, and the one API that might reduce this (`subsetFonts()`) does nothing
for a font that isn't yet used — which is the exact moment a text tool would need to register one.
For a typical single-weight TTF (a few hundred KB to a few MB is common), this is several hundred
KB to multiple MB added to a document for using a custom font even once. This is a measured,
real cost, not a guess.

## DECISION: pdf-lib as a runtime dependency

**YES** — because:

1. **Measured cost, not assumption.** `addSimpleFont()`/`addFont()` embed the *entire* font
   program (Flate-compressed only) on registration, confirmed at two very different font sizes
   (57–65% of raw bytes both times). There is no automatic subsetting.
2. **The one subsetting escape hatch is unproven and untrustworthy as-is.** `doc.subsetFonts()`
   exists but measurably does nothing for a font that hasn't yet been used to draw content — which
   is precisely the state right after registration. Whether it works once content *is* drawn is
   unverified; betting a text-editing tool's per-edit file-size budget on an unverified code path
   in a spike is not a responsible default.
3. **`@pdf-lib/fontkit` is already present** as a devDependency and is purpose-built, widely used
   specifically for TTF subsetting — a known-good tool for exactly this one job, versus an
   unverified mupdf method.
4. **Scope stays narrow.** This decision is strictly about the font-embedding/subsetting step.
   MuPDF remains the single export/render/annotation engine for everything else (rendering,
   annotations, page composition, save), per spec §1's single-engine-choice principle. `pdf-lib`
   does not become a general-purpose write path — only the font path.

**Action**: Update `PLAN.md` §8 to move `pdf-lib` from "conditional" to "included" as a runtime
dependency, scoped to font subsetting/embedding for the text tool's custom-font path. The exact
integration shape (pdf-lib produces subsetted font bytes that mupdf then embeds via
`new mupdf.Font(name, subsetBytes)` / `addSimpleFont`/`addFont`, vs. pdf-lib owning the whole
font-registration step) is real design work for a later task, not this spike.

## Other findings worth flagging (not required by Q1–Q5, but plan-relevant)

- `PDFDocument`'s prototype exposes far more than the brief's `addSimpleFont`/`addCJKFont`/
  `addFont` — notably `subsetFonts()` (above), a full undo/redo journal
  (`enableJournal`/`beginOperation`/`endOperation`/`undo`/`redo`/`canUndo`/`canRedo`), page
  management (`addPage`/`insertPage`/`deletePage`/`rearrangePages`), layers (OCG) support, and
  `addEmbeddedFile`. None of these were exercised — flagged only so a later task planner knows
  they exist rather than reaching for pdf-lib out of habit.
- `Stamp` annotations get a default "DRAFT" appearance from mupdf itself when no icon/contents is
  set — a MuPDF default, not something the caller configured. Worth knowing before assuming an
  empty Stamp annotation renders as literally empty.
- **Corrected in this revision**: an earlier pass of this spike claimed the Link/`Rect` low-level
  `put()` escape hatch hard-aborts the WASM runtime. Re-verified with every call individually
  try/catch-wrapped (`spikes/09-link-rect-abort.ts`) and that does **not** reproduce — the real
  behavior is an ordinary catchable `Error` on `getRect()`/`setRect()`, and the low-level
  `PDFObject.put()` write itself succeeds without crashing (though it's functionally inert: the
  Link still won't produce a working `/Rect`/`/AP` afterward). The original "abort" observation
  was a misread of Node's default uncaught-exception output for an *unwrapped* call, not a real
  WASM-level crash — see the Q1 section above for the full trace. The Task 3 disposal finding (a
  genuine WASM heap OOM, confirmed via RSS measurements and a real fatal `malloc` failure) remains
  the correct example of this binding failing hard; this Link/`Rect` case does not belong in that
  category after all.
