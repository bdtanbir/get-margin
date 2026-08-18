# Phase 0 decision record

Engine: mupdf@1.28.0 (plan assumed `^1.26.0`; drift documented throughout the four findings docs) · Node v23.7.0 dev (repo requires `>=22`) · 2026-08-18
Sources: `01-read-path.md` · `02-write-path.md` · `03-encryption.md` · `04-raw-objects.md` · consolidated engine facts: `00-engine-facts.md`

This is the single source of truth Phase 1 and every later phase should treat as settled. `PLAN.md` has
been amended throughout to match it — see that file's per-section changes for the reasoning; this
document is the compact reference table.

## Settled dependencies

| Question | Decision | Source |
|---|---|---|
| pdf-lib as a runtime dependency? | **YES** (font subsetting/embedding path only — MuPDF stays the single engine for everything else) (promoted at the font task in Phase 4 — currently devDependency, fixture generator only) | `02-write-path.md` Q5, "DECISION: pdf-lib as a runtime dependency" |
| qpdf-wasm needed for encryption? | **NO** — MuPDF writes genuine AES-256 encrypted PDFs natively via `saveToBuffer('encrypt=aes-256,...')` | `03-encryption.md` Q1/Q2, "DECISION: qpdf-wasm" |
| Pixmap disposal required? | **YES — mandatory, not optional.** Omitting `.destroy()` hard-crashes the WASM heap (`malloc failed`) within a single 300–600 page sweep; with disposal, RSS drift is ~5–7MB flat over the same sweep. | `01-read-path.md` Q3 |
| MuPDF applies rotation automatically | **TRUE** — pixmap dimensions swap for 90°/270°, and `getTransform()`'s matrix already contains the rotation. `render.ts` must pass a scale-only matrix; `transform.ts` must still compose rotation itself, because it maps unrotated PDF-space geometry onto this same already-rotated page space. | `01-read-path.md` Q6 |
| `getBounds()` returns | **CropBox**, origin-normalized to `(0,0)` — confirmed `getBounds() === getBounds('CropBox')`. Callers must not re-subtract a crop origin that MuPDF has already zeroed out. | `01-read-path.md` Q5 |
| Structured-text option string | **Any string works, including `''`** — the options string (`toStructuredText(options?)`) affects internal text segmentation only, not the JSON schema. `StructuredText.asJSON()` itself takes only a numeric `scale`, no options string at all — this is API drift from what the original plan assumed. | `01-read-path.md` Q4 |

## Settled capabilities

| Capability | Verdict | Consequence |
|---|---|---|
| Native annotations render cross-viewer | **YES for MuPDF vs. Apple CoreGraphics** — 9 of 10 tested types (all but Link, which has no `/AP` concept by design) produce real `/AP` streams, and the two available renderers agree pixel-for-pixel with no disagreement found. **Acrobat and Chrome are NOT VERIFIED** — no GUI was available in the spike environment; this is a genuine open item, not inferred as passing. | `annots.ts` (write path) can rely on MuPDF's auto-generated appearance streams. **Human check of Acrobat/Chrome is a blocking item before §2.1's annotation features are called done** — see "Human verification required" below. |
| FreeText sufficient for the text tool | **PARTIAL** — sufficient only for the standard 14 base fonts (size/color/family/alignment all work via auto-generated `/AP`). A custom registered font is silently ignored: no `/DR` is created, and MuPDF's own `getDefaultAppearance()` reads back `Helv` regardless of what was set. | `write/drawText.ts` scope: base-14 text can use `FreeText`; custom/self-hosted fonts must be drawn as content-stream text operators (`Font`+`Text`+`Device`, confirmed working end-to-end and measured accurate to 5 decimal places) or a hand-built `/DR`. §6's font picker must not route custom fonts through the `FreeText` path. |
| Arbitrary TTF embedding | **YES** — `new mupdf.Font(name, bytes)` + `doc.addSimpleFont`/`doc.addFont` work on arbitrary TTFs; drawing and measurement are sound (verified to 5 decimal places against an independent glyph-advance sum). | `fonts.ts` scope: arbitrary custom fonts are usable, not just the curated self-hosted set — subject to the subsetting cost below. |
| Font subsetting automatic | **NO** — registering a font costs 57–65% of its raw byte size immediately (plain Flate compression of the whole program), measured at two very different scales (22.2MB → ~14.9MB; 755KB → ~431KB). `doc.subsetFonts()` exists but made zero measurable difference for a freshly registered, undrawn font across three configurations. | Export size budget: this is why `pdf-lib` + `@pdf-lib/fontkit` became a runtime dependency (see above) — MuPDF alone would add several hundred KB to multiple MB per custom font used even once. |
| Encrypted save | **YES** — `saveToBuffer('encrypt=aes-256,user-password=...,owner-password=...')` writes genuinely AES-256 encrypted PDFs, confirmed three independent ways (`needsPassword()`, raw `/Encrypt` dict via `strings`, CoreGraphics refusing to render). `permissions=<bitmask>` genuinely enforces (verified against an arbitrary bit combination). **Trap**: passwords without an `encrypt=` key save silently with no encryption at all. | §2.3 approach: build password-protect on this option string, but the implementation **must** reopen its own output and assert `needsPassword() === true` before reporting success — this is a mandatory safety check, not a nice-to-have. Permission restrictions (print-only, no-copy, no-edit) are a real, shippable capability the original plan didn't know it had. |
| Form widget creation from scratch | **YES, easier than assumed** — ~9 lines per field once a one-time ~20-line `/AcroForm`+`/DR` wiring exists. Text, checkbox, and combo fields were all built, wired, and round-tripped through save/reload with no dead ends. MuPDF auto-generates real `/AP` appearance streams for every type, including two-state checkbox appearances. | Phase 5 estimate **confirmed at 3 weeks** (hedge to 4 weeks removed); risk marker downgraded 🔴→🟡. Two things stay open and gate "done": radio-group parent/kid `/T`+`/AS` semantics are untested (half-day mini-spike recommended at the start of Phase 5), and interactive behavior in Acrobat/Chrome is unverified. |
| Content-stream read/modify/write | **YES** — `readStream()`/`writeStream()` transparently handle `/FlateDecode` on both read and write; no manual decode/encode step is needed anywhere in this path. A naive regex over `Tj`/`TJ` operators is provably fragile (see below). | Phase 6 redaction approach shifts from hand-rolled content-stream surgery to `PDFPage.applyRedactions()`, MuPDF's own primitive, discovered mid-spike and not mentioned in the original plan. |
| Text unextractable after stream patch | **YES, genuinely** — confirmed by both the manual patch and by `applyRedactions()`: a fresh cold-reopen re-extraction shows the target text gone, not merely covered, with the rest of the page rendering undamaged (cross-checked against CoreGraphics, no disagreement). **Caveat**: this is MuPDF checking its own output; a naive regex was separately proven to silently miss a `TJ` array containing a literal `]`, which is exactly the failure mode the original plan speculated about. | The whiteout-vs-redaction distinction in §2.1 can now be presented to users honestly — there is a verified *real* removal mechanism, not two cosmetic covers. **But**: before redaction ships as a user-facing safety guarantee, verify with a genuinely independent extractor (`pypdf`/`pdfminer`/`pdftotext`/Acrobat) — MuPDF checking its own write is not independent verification. Track this as a release gate on the redaction feature specifically. |

## Revised estimates

| Phase | Spec estimate | Revised | Why |
|---|---|---|---|
| 5 — Forms | 3 weeks, with a "could slip to 4" hedge | **3 weeks, hedge removed — confirmed, not just estimated** | `04-raw-objects.md` Q2/Q3 ("PHASE 5 ESTIMATE"): field creation measured at ~9 lines/field + ~20 lines one-time wiring, with mupdf handling appearance-stream generation for free — the single largest anticipated cost. Radio groups and Acrobat/Chrome interactivity remain open checkpoints, not schedule risk. |
| 6 — Advanced | 3.5 weeks (text patching ~1.5 weeks of it) | **3 weeks (text patching ~1 week of it)** | `04-raw-objects.md` Q5/Q6 ("PHASE 6 ESTIMATE"): adopting `PDFPage.applyRedactions()` instead of a hand-rolled content-stream tokenizer removes the need to write a real string-literal-aware parser (the naive-regex failure was proven, not hypothetical) — a ~10-line call replaces what would otherwise be 2–3 days of tokenizer work. |

Cascading effect on the roadmap: every phase after Phase 6 shifts down by the same 0.5 week (Phase 7:
weeks 15–19, Phase 8: weeks 19–21.5; full parity ~21.5 weeks total, down from ~22). See `PLAN.md` §7.

## Measured performance baseline

300-page render (`large-300p.pdf`, 612×792, ~41 text lines/page, Apple M1 Pro, 16GB RAM): **827.9 pages/sec at 1.0×, 687.4 pages/sec at 2.0×.** First-page timing is sub-20ms at this scale (noisy at single-digit-ms resolution — treat as "render is fast, sub-frame-budget" rather than a precise number, not as a literal per-page figure to build a budget on). Peak RSS observed: **210MB**, flat across 600 total page renders (both scale passes, with disposal). Document-open time is excluded from the timed region in both cases.

**Phase 1 budget: first page visible within ~1000ms of file drop**, proposed rather than measured. The
300-page-sweep numbers above are desktop-only (M1 Pro) and exclude document-open, WASM-module load, and
file I/O — none of which were benchmarked in Phase 0, and all of which dominate perceived latency far
more than per-page raster time does. Per-page rendering itself is so far under any reasonable budget
(sub-20ms) that it is not the constraint; WASM load + first document open on a **mid-range phone**, which
this plan explicitly commits to supporting, is the real unknown and should be measured directly in
Phase 1 rather than assumed from this desktop figure.

## Blocking issues for Phase 1

**None.** Phase 1 is a read-only viewer shell — open, render, scroll, zoom. Every open item from Phase 0
(radio-group semantics, Acrobat/Chrome verification of annotations/widgets/encrypted files, independent
extractor verification of redaction, the AGPL/commercial license decision) affects Phase 5, Phase 2/6,
Phase 6, or launch respectively — none of them touch what Phase 1 builds. Phase 1 can proceed on the
settled read-path facts above (disposal, rotation, CropBox, structured-text shape) without waiting on
anything still open.

## Human verification required (hand to the user)

Phase 0 ran in a non-GUI environment (no Acrobat, no Chrome, no interactive Preview). Everything below
was checked as thoroughly as that environment allows — cross-referenced against a second engine
(Apple's CoreGraphics via `qlmanage`) wherever possible — but none of it substitutes for opening the
actual applications a user will use.

1. **Acrobat and Chrome rendering of MuPDF-generated annotations, form widgets, and encrypted PDFs.**
   MuPDF and CoreGraphics agree exactly with no disagreement found, and real `/AP` streams exist for
   every working annotation and widget type, so there is no *positive* evidence of risk — but that is
   not the same as having verified it. Evidence preserved for this check (moved out of the now-deleted
   `spikes/` directory specifically so this remains possible):
   `docs/findings/evidence/out-annots.pdf`, `docs/findings/evidence/out-annots-mupdf-render.png`,
   `docs/findings/evidence/out-annots-coregraphics-render.png`.
2. **Radio-group parent/kid `/T`+`/AS` semantics** — untested by any spike. Recommended: a half-day
   mini-spike at the very start of Phase 5, before committing further to its 3-week estimate.
3. **Independent (non-MuPDF) verification of `applyRedactions()`'s text removal** — `pypdf`, `pdfminer`,
   `pdftotext`, or Acrobat's own text export. Required before redaction is presented to users as a safety
   guarantee, not merely an internal finding. Track as a release gate on the redaction feature.
4. **AGPL vs. commercial license — this gate has already been reached, not merely upcoming.** `PLAN.md`
   §0 frames this as a decision to make "before public launch (phase 8 at the latest; start the
   conversation around phase 5)." That framing undersells the urgency: `origin` (`github.com/bdtanbir/
   get-margin`) is a **public** repository, and the `mupdf` dependency has been present in `package.json`
   since the repo's second commit (`6a2b2c1`), already pushed to `origin/phase-0-1`. The AGPL distribution
   clause is triggered by the push, not by launch — the gate this decision needs to clear has already
   passed without the decision being made. This needs attention now, not "by phase 5."
