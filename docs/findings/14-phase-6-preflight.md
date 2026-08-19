# Phase 6 pre-flight — redaction is real, compression is not, and there is a second password trap

Phase 6 is the highest-variance phase in the plan, and it carries the only **release gate that is
about safety rather than schedule**. Measured before any design was written.

## 1. Redaction genuinely removes text — verified by two independent extractors

`PLAN.md` §2.4 makes this a condition of shipping redaction *as a safety claim*:

> the "text is genuinely gone" result above rests on MuPDF's own write → cold-reopen → re-extract
> round trip … Before this feature is presented to users as a safety guarantee, verify removal with
> a genuinely independent extractor.

Done, with **two**: `pypdf` 6.16.1 and `pdfminer.six`, both pure Python, neither sharing a line with
MuPDF. Eight cases, each checked three ways — MuPDF's own re-extraction, both extractors, and a raw
byte search of the file:

| Case | pypdf | pdfminer | raw bytes |
|---|---|---|---|
| First word of a line | gone | gone | gone |
| Word in the **middle** of a line | gone | gone | gone |
| **Part** of a word (`extra` of `extraction`) | gone | gone | gone |
| `/Rotate 0` | gone | gone | gone |
| `/Rotate 90` | gone | gone | gone |
| `/Rotate 180` | gone | gone | gone |
| `/Rotate 270` | gone | gone | gone |
| `black_boxes = false` | gone | gone | gone |

**The gate is satisfied.** Two things it also settles, both listed as untested in §2.4:

- **Rotated pages work.** All four rotations, driven from the same `buildQuadIndex` quads Phase 2
  already produces. (Genuinely *skewed* text remains untested — no fixture has any.)
- **It is glyph-precise, not run-precise.** Redacting `body` from the middle of a line left `Second`
  and `extraction` intact; redacting `extra` from `extraction` left `ction`. This was the real risk —
  a redaction that silently swallowed the rest of its text run would be data loss dressed as safety.

Driven by `/QuadPoints` on a `Redact` annotation, as §2.4 says — not `/Rect`.

### The one product decision this forces

`applyRedactions(false)` removes the text and **draws nothing**. The file is safe and looks
untouched, which for this feature is the wrong kind of quiet: a user cannot tell redaction happened,
and neither can anyone they send it to. Default to black boxes, and treat "no mark" as an explicit
choice rather than an option with an innocent default.

## 2. A second password trap, worse than the documented one

§2.2 warns that `user-password=` without `encrypt=` produces an unprotected file. Reproduced exactly:

```
user-password + owner-password, no encrypt=  -> saved, no throw, 1186 bytes, needsPassword=FALSE
encrypt=aes-256 + both passwords             -> saved, no throw, 2061 bytes, needsPassword=true
encrypt=aes-256, NO password                 -> saved, no throw, 2061 bytes, needsPassword=FALSE
```

The third line is new and is not in the spec. `encrypt=` with no password produces a file that is
genuinely encrypted — the size jumps like the protected one, and an `/Encrypt` dictionary is written
— **and opens with no prompt at all.** It looks protected by every cheap measure and protects
nothing.

So the mandatory check is not "did `saveToBuffer` throw" and not "does the file look encrypted". It
is: **reopen the output and assert `needsPassword() === true`** before telling the user their
document is protected. Both traps are silent, both produce plausible files, and only that assertion
separates them.

### A third trap, found while building Task 83

Removing a password has the mirror-image problem. MuPDF's save default is `encrypt=keep`, so
authenticating a protected document and saving it normally produces a file that is **still
encrypted**:

```
authenticate('p') then save 'compress'        -> needsPassword=TRUE,  text extracts as ""
authenticate('p') then save 'compress,encrypt=none' -> needsPassword=false, text extracts fine
'compress,decrypt' also works; 'compress,encrypt=keep' is the default and does not
```

A user told "password removed" would get a file that still demands the password they asked to be rid
of — and because the text extracts as empty, it reads as a *corrupted* document rather than a locked
one, which is a worse diagnosis to hand someone.

`encrypt=none` is therefore not optional, and `removeProtection` verifies its own output the same way
`protectedSave` does. All three traps now have tests that build the broken call by hand and assert it
produces the wrong thing, so the guards are measured against what they guard rather than against an
assumption about it.

## 3. Permission bits, mapped rather than assumed

§2.2 says to treat `permissions=` as empirically derived because it is not a literal key in the wasm
string table. Every bit was set individually and read back through `hasPermission`:

| Bit | Value | Grants |
|---|---|---|
| 3 | 4 | `print` |
| 4 | 8 | `edit` |
| 5 | 16 | `copy` |
| 6 | 32 | `annotate` |
| 9 | 256 | `form` |
| 10 | 512 | `accessibility` |
| 11 | 1024 | `assemble` |
| 12 | 2048 | `print-hq` |

Bit 2 grants nothing. Every bit lands exactly where the PDF specification says it should, and
MuPDF's own permission names match one-to-one — so the protect dialog can be a straightforward list
of checkboxes rather than a guessing game. `permissions=0` denies everything; `-4` (all bits set)
allows everything.

## 4. Metadata: `/Info` is easy, XMP is hand-rolled, and they can disagree

`getMetaData('info:Title')` / `setMetaData` work and round-trip through a save. But:

- The fixture has **no `/Metadata` XMP stream**, and `setMetaData` **does not create one**.
- A hand-written XMP packet added as a `/Type /Metadata` stream survives a save and reopen intact.

So "metadata (Info + XMP)" is two jobs, not one, and the interesting part is that **nothing keeps
them in sync**. A file whose `/Info` says one title and whose XMP says another is valid, and
different readers will believe different halves. The feature has to write both or neither.

## 5. Compression, as specified, makes files bigger

This is the finding that changes a feature. §2.2 says structural gains come from
`garbage=compact,compress` and that "real wins need image downsampling". The first half is worse
than optimistic — it is negative:

| Document | Original | After `compress,garbage=compact` |
|---|---|---|
| Vector-heavy (4000 shapes) | 12,381 B | 12,687 B (**+2%**) |
| One 1600×1200 JPEG | 3,305 KB | 3,306 KB (**+0%**) |

Re-serialising a file that was already well-written costs more than it saves. A "compress" button
that reliably returns a *larger* file is worse than no button.

Image re-encoding is where the wins actually are. Same 3,304 KB source image:

| Quality | Size | Saved |
|---|---|---|
| q80 | 2,348 KB | 29% |
| q60 | 1,592 KB | 52% |
| q40 | 1,213 KB | 63% |

So the feature is **image recompression with quality presets**, not a save-options flag, and it must
**measure its own output and refuse to hand back a file bigger than the original** — offering the
original instead. Reachable via the page's `/Resources /XObject`, then `doc.loadImage(ref)` →
`toPixmap()` → `asJPEG(quality)`.

## 6. Font subsetting is worth ~20× and its dependency was never installed

§2.5 records a DECISION that `pdf-lib` + `@pdf-lib/fontkit` is a runtime dependency for subsetting.
The decision was written down and the package was never added — found by trying to use it.

Measured, embedding one face and drawing twelve characters:

| Font | Raw | MuPDF, no subsetting | pdf-lib + fontkit, subset |
|---|---|---|---|
| Inter | 65 KB | 32 KB (49%) | **2 KB (3%)** |
| JetBrains Mono | 56 KB | 28 KB (51%) | **2 KB (3%)** |
| Caveat | 110 KB | 61 KB (55%) | **3 KB (3%)** |
| Merriweather | 127 KB | 70 KB (55%) | **2 KB (2%)** |

The 49–55% figure matches §2.5's earlier measurement. Subsetting turns it into 2–3%. This has been
deferred twice — from Phase 2, and again in Phase 4 §0 — on the honest grounds that it was an
optimisation rather than a capability. Text patching changes that: its font-fallback path embeds a
substitute face on any glyph miss, so a deferred optimisation becomes a per-export cost.

### Correction, from building Task 89: it is deferred again, now for a measured reason

Two things turned out differently once this was implemented.

**MuPDF's own `subsetFonts()` is not useless — §2.5 measured it under the wrong condition.** The spec
records that it "made zero measurable difference", which is true for a font *registered but not yet
drawn*: there are no glyph usages to subset against, so there is nothing for it to do. Once text is
actually written it does something dramatic — a document using one face went from **33 KB to 4 KB**,
an 88% saving, with the text still extracting correctly.

**And it renders the document wrong.** It rewrites the embedded font without keeping `/Widths` in
step, so every glyph advance changes: right-aligned text missed its box edge by **113 points**, and
four of Phase 2's golden images moved. Text extraction kept working the whole time, which is what
makes it dangerous — the cheap verification passes on a visibly broken document, and anyone checking
subsetting by extracting text would ship it.

**`@pdf-lib/fontkit`'s subsetter does not work here either.** `createSubset()` exists, but `encode()`
throws `Cannot read properties of undefined (reading 'pos')` for both glyph objects and glyph ids.
Not investigated further, because the MuPDF result made the cheaper path look viable first.

So subsetting is **deferred a third time, and this time the reason is measured rather than
scheduling**. `test/write/subsetAttempt.test.ts` pins all of it — including the 88% prize — and will
fail if a future MuPDF fixes the metrics, at which point the saving is worth taking. The dependency
§2.5 decided on has been removed again, so MuPDF remains the only engine that touches a PDF.

## 7. One API gotcha, recorded so it is not rediscovered

`PDFObject.isStream()` **follows an indirect reference**, but the object returned by `.resolve()`
reports `isStream() === false` while still answering `get()` correctly. Walking XObjects by
resolving first therefore finds nothing, silently. Test the reference, and pass the reference to
`loadImage`.

## What this changes before design

- Redaction can be built and can be **called** redaction. The gate is met.
- Password protection needs a mandatory self-check, not a happy path.
- "Compression" is image recompression, with a floor at the original size.
- Metadata is two writers.
- Font subsetting stops being optional and enters this phase.

Nothing here moves the phase's scope. Two things it makes cheaper than budgeted (permissions,
redaction), one more expensive (compression), and one that was already decided but unbuilt
(subsetting).
