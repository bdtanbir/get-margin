# Phase 6 verification — advanced document ops

Tasks 79–94. **1,325 unit tests, 67 e2e** across desktop and phone, clean `tsc`, `vue-tsc`, and
build.

## The headline: redaction's release gate is met, and stays met

`PLAN.md` §2.4 makes independent verification a condition of presenting redaction to users as a
safety guarantee, rather than a condition of the phase. It is met — and wired into the suite so it is
re-checked on every commit rather than once.

`pypdf` and `pdfminer.six`, two pure-Python extractors sharing no code with MuPDF, over eight cases:
a whole word, a word mid-line, **part** of a word, all four page rotations, and black-boxes-off.
Everything gone everywhere, confirmed a third way by raw byte search.

Two properties matter as much as the removal itself, and both have tests:

- **It is glyph-precise.** Removing `body` from a line kept `Second` and `extraction`; removing
  `extra` from `extraction` kept `ction`. A redaction that swallowed the rest of its text run would
  be data loss dressed as safety.
- **The `Redact` annotation is consumed.** A leftover one would tell any reader exactly what was
  hidden and where.

The gate **fails loudly when its tooling is missing** rather than skipping. A safety check that
silently no-ops is worse than none, because it reports success. Verified by hiding the venv and
watching the suite fail with setup instructions. It also carries a control — an assertion that the
extractors still read text that was *not* redacted — because an extractor silently returning nothing
would make every "gone" assertion vacuous and the suite green for the worst possible reason.

**Not in scope, deliberately:** images and vector art. Those `applyRedactions` paths are unexercised
(§2.4) and the pre-flight tested text only. A redaction that silently failed to remove a face from a
photograph is the exact failure this feature exists to prevent, so the UI redacts text selections and
says so.

## Covered on every commit

| Area | Check | Where |
|---|---|---|
| Redaction | Eight cases verified by two independent extractors, re-run every commit | `redact-independent.test.ts` |
| Redaction | Word, mid-line, partial word, four rotations; neighbours survive; annotation consumed | `redact.test.ts` |
| Redaction vs whiteout | Whiteout leaves text extractable, redaction does not — asserted side by side | `redact.test.ts` |
| Password | All **three** silent-failure modes produce the wrong thing, and `protectedSave` produces neither | `protect.test.ts` |
| Password | Every permission bit granted individually; removal needs the user password | `protect.test.ts` |
| Password UI | The caveat that permissions are viewer-enforced; a failed protect downloads nothing | `ProtectDialog.test.ts` |
| Stamping | Tokens per page, Bates sequences, `behind` ordering, exact geometry on four rotations | `stamp.test.ts` |
| Stamping | Stamps are page CONTENT, not annotations | `stamp.test.ts` |
| Stamping UI | Presets replace wholesale; document-vs-selection numbering; one undo for the run | `StampDialog.test.ts` |
| Metadata | `/Info` and XMP agree; strip removes both plus `/ID`; identical bytes for identical inputs | `metadata.test.ts` |
| Compression | Real shrinkage; **the original is returned when compressing would grow it**; shared images once | `compress.test.ts` |
| Compression UI | Measured before committing; preset change clears stale numbers; "already smallest" stated | `CompressDialog.test.ts` |
| Find | Ligatures both directions with offset mapping; typographic equivalents; whole-word; overlaps | `find.test.ts` |
| Find UI | Stale responses discarded; capped counts marked; source→display page mapping after reorder | `FindPanel.test.ts` |
| Patching | The hash guard refuses and names both texts; a refusal fails the whole export | `patch.test.ts` |
| Patching | Covers rather than removes — asserted by extracting the original afterwards | `patch.test.ts` |
| Patching UI | Background sampled around the line, median not mean; confidence separates flat from photo | `sampleBackground.test.ts` |
| Patching UI | Both warnings shown before committing; unrendered page reports zero confidence, not white | `PatchEditor.test.ts` |
| Replace | One patch per line however many matches; right-to-left offsets; one undo; skips reported | `buildReplacements.test.ts` |
| Subsetting | The 88% prize, the moved glyphs, and the extraction check that fails to notice | `subsetAttempt.test.ts` |

## What this phase found that the spec had wrong

Four corrections, all from measurement:

1. **A third password trap.** MuPDF's save default is `encrypt=keep`, so authenticating a protected
   document and saving normally leaves it **still encrypted** — and its text extracts as empty, so it
   reads as a *corrupted* document rather than a locked one. `encrypt=none` is required.
2. **Compression as specified grows files.** The structural pass added 2% to a vector-heavy document.
   The feature is image recompression with a hard floor, not a save flag.
3. **Permission bits are exactly the PDF spec's**, so the protect dialog is a list of checkboxes
   rather than a guessing game. §2.2 had flagged them as empirically derived and unknown.
4. **Font subsetting is not available.** See below.

## Font subsetting: attempted, deferred a third time

The most interesting failure in the phase, and the one I would most want a reviewer to read.

§2.5 records that `subsetFonts()` "made zero measurable difference" — true for the case it tested, a
font *registered but not yet drawn*, which has no glyph usage to subset against. Once text is
actually written it does something dramatic: **33 KB → 4 KB, an 88% saving**, text still extracting
correctly. One line, no new dependency, and a feature deferred twice looked finished.

It renders the document **wrong**. `subsetFonts()` rewrites the embedded font without keeping
`/Widths` in step, so every glyph advance changes: right-aligned text missed its box edge by **113
points** and four Phase 2 golden images moved.

**Text extraction kept working throughout.** That is what makes it a trap rather than a bug — the
obvious way to verify subsetting is to extract the text, and that check passes on a visibly broken
document. The Phase 2 golden images caught it, which is precisely what they were built for and the
clearest argument this project has for a pixel comparison over a text assertion.

`@pdf-lib/fontkit`'s subsetter throws on `encode()` for these fonts, so the fallback §2.5 assumed was
available is not. Exports still embed full faces at 49–55% of raw font bytes.
`subsetAttempt.test.ts` pins all of it, so a future MuPDF that fixes the metrics fails the suite
loudly and the saving becomes available.

## Two tests that were passing for the wrong reason

Both mine, both the same shape — **an expected value that coincides with the do-nothing state** —
and worth recording because neither was found by reading:

- `mountEditor(undefined)` hit a JavaScript default parameter and mounted the *populated* index, so
  the "page not yet extracted" case never tested that.
- A find test asserted the viewport anchor was `0` after reversing a document, while the page lookup
  returned "not found" every time and `setAnchor` was never called. `0` was both the expected answer
  and the untouched default.

The second was only exposed because a *different* bug — reading page identity from a store that
needs registered sources — made the lookup fail everywhere at once. Both tests now start from a
state the correct answer differs from.

## Outstanding

### 1. Human verification, unchanged and accumulating

The list from Phases 4 and 5 stands, and this phase adds to it. No agent here has a GUI or a phone.

| Check | Since |
|---|---|
| Exports open correctly in Acrobat, Preview, Chrome | Phase 2 |
| A run on real phone hardware | Phase 4 |
| Created form fields are actually interactive in Acrobat and Chrome | Phase 5 |
| **A redacted file opened in Acrobat shows no trace of the removed text** | Phase 6 |
| **A protected file actually prompts for its password in Acrobat and Preview** | Phase 6 |
| **A watermark drawn `behind` sits under the page content rather than over it** | Phase 6 |

The last three are new. The first two of them are checks on claims the product makes about safety,
which is a different weight of gap from a rendering question.

### 2. Smaller, recorded

- **Text patching covers rather than removes.** The original glyphs remain in the content stream
  under an opaque rectangle. Someone who needs the old text *gone* wants redaction, and the UI keeps
  those separate — but a user who assumes patching removes text would be wrong.
- **Find does not match across a line break.** A line is the unit with geometry; a cross-line match
  has no single region to highlight. Every PDF reader has this limitation.
- **Replace-all mostly cannot sample backgrounds**, because it reaches pages that were never
  rendered. It reports how many, rather than assuming white.
- **Patching uses a bundled face, not the document's own font.** §2.4 anticipates reusing the
  original where possible; this phase does not, so a patched line changes typeface.
- **Compression skips CMYK and indexed images** rather than mangling them.
- **No CI exists in this repository**, so none of the above runs anywhere but locally. The redaction
  gate's failure message names what to install when someone sets one up.
