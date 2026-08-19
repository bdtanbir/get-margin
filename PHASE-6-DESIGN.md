# Phase 6 — Advanced document ops

**Spec:** `PLAN.md` §2.3, §2.4, §7. **Pre-flight:** `docs/findings/14-phase-6-preflight.md`, which
overturned one feature's design and added a mandatory safety check to another.

## 0. Sequencing, which the roadmap already decided

> Ship the rest of phase 6 first so text editing can slip without blocking the release.

Taken literally. The phase splits into two unequal halves:

**The eight tractable features** — watermark, page numbers / header / footer, Bates, metadata,
compression, password, redaction, find & replace. Most reuse machinery that already exists.

**Text patching**, which `PLAN.md` §2.4 calls the hardest thing in the product. It goes last, alone,
and if it slips nothing else is waiting on it.

Font subsetting was scheduled into this phase, having been deferred from Phase 2 and again from
Phase 4, on the strength of the pre-flight measuring it at ~20×. It was attempted and **deferred
again** — see §8, and the correction in findings 14 §6. Exports still embed full faces.

## 1. The stamping family — watermark, page numbers, header/footer, Bates

Four features, one writer. They differ in what text they produce and where it goes, not in how it is
drawn, and building them as four writers would be four places to fix the same bug.

```ts
type StampSpec = {
  kind: 'watermark' | 'pageNumber' | 'header' | 'footer' | 'bates'
  template: string            // "{n} of {total}", "CONFIDENTIAL", "ACME-{bates}"
  pages: PageRange            // reuses lib/pageRanges.ts from Phase 3
  position: StampPosition     // nine-box grid, or centred for a watermark
  margin: number
  font: { family: string; size: number; color: Color; opacity: number }
  rotation: number
  behind: boolean             // under existing content, or over it
  bates?: { start: number; step: number; digits: number; prefix: string; suffix: string }
}
```

Tokens are substituted per page: `{n}`, `{total}`, `{filename}`, `{date}`, `{bates}`. One resolver,
so a token that works in a footer works in a watermark.

**Drawn as content-stream text, not as annotations.** A watermark someone can select and delete in
their PDF reader is not a watermark. This is the opposite of the Phase 2 semantic split — ink and
highlights are *supposed* to stay editable — and the difference is intent: a markup annotation is
the user's note on a document, a watermark is a property of the document.

**`behind: true` prepends to the content stream** rather than appending. A watermark over a photo is
unreadable; under it is invisible. Both are wanted, so both are offered, and neither is the obvious
default — headers and footers go over, watermarks go under.

Stamps are ordinary `EditObject`s of a new kind, so they undo, redo, and autosave like everything
else. What makes them a feature rather than "draw text on 300 pages by hand" is the dialog that
generates them across a range in one op.

## 2. Redaction

The one feature where being wrong has consequences for someone who trusted it.

`applyRedactions()` driven by `/QuadPoints` on a `Redact` annotation, sourced from the same
`buildQuadIndex` quads Phase 2's markup tools already use. The pre-flight verified removal with two
independent extractors across eight cases including partial words and all four page rotations
(findings 14 §1), which satisfies §2.4's release gate.

**Three rules this feature does not bend:**

1. **Black boxes by default.** `applyRedactions(false)` removes the text and draws nothing — the
   file is safe and looks untouched. For redaction that is the wrong kind of quiet: neither the user
   nor the person they send it to can tell it happened. "No mark" stays available as a deliberate
   choice, never as a default.
2. **Redaction is applied on export, to the export copy, like every other op.** It is undoable in
   the editor because it is an op; it is irreversible in the exported file because that is the point.
   The UI must not let those two be confused — see §7.
3. **Never call anything else redaction.** Whiteout covers, and Phase 2's copy is emphatic about
   that. Now that a real redaction exists, the distinction gets sharper rather than softer: the two
   tools sit apart in the rail and the whiteout notice gains a pointer to the real thing.

**Images and vector art are out of scope.** `applyRedactions`'s `image_method` and `line_art_method`
paths are unexercised (§2.4), and the pre-flight tested text only. A redaction that silently fails to
remove a face from a photograph is exactly the failure this feature exists to prevent, so the UI
redacts text selections and says so, rather than offering a rectangle over an image and implying
more than was measured.

## 3. Password and permissions

`saveToBuffer('encrypt=aes-256,user-password=…,owner-password=…,permissions=…')`.

**The mandatory self-check.** The pre-flight found two ways to produce a file that looks protected
and is not: passwords without `encrypt=` (documented in §2.2), and — new — `encrypt=` with no
password, which writes a real `/Encrypt` dictionary and opens with no prompt. Both save cleanly and
throw nothing.

So the export path **reopens its own output and asserts `needsPassword() === true`** before
reporting success, and fails loudly otherwise. A non-throwing `saveToBuffer` is not evidence.

Permissions are a list of checkboxes, backed by the bit table the pre-flight measured (findings 14
§3): print, edit, copy, annotate, form, accessibility, assemble, print-hq. Every bit lands where the
PDF spec says and MuPDF's names match one-to-one.

**What the dialog must say.** PDF permissions are enforced by the *viewer*, not the file — a
determined reader ignores them. The dialog says so, because a user who believes "no copy" is a
technical guarantee is being misled by omission. The open password is real encryption; the
permissions are a request.

Removing a password requires the *user* password, not the owner password. This does not break
encryption and will not pretend to.

## 4. Compression

Rewritten from the spec after measurement. §2.2 assumed structural gains from
`compress,garbage=compact` with image work as the stretch goal. The pre-flight found the structural
pass **grows** files — +2% on a vector-heavy document, +0.03% on an image-heavy one — because
re-serialising an already-well-written file costs more than it saves.

So compression is **image recompression**, with three presets:

| Preset | Max dimension | JPEG quality | Measured on a 1600×1200 photo |
|---|---|---|---|
| Light | 2400 px | 85 | ~25% |
| Balanced | 1600 px | 65 | ~50% |
| Small | 1200 px | 45 | ~60%+ |

Reached through the page's `/Resources /XObject`, then `doc.loadImage(ref)` → `toPixmap()` →
`asJPEG(quality)`. Note the API gotcha from findings 14 §7: `isStream()` follows an indirect
reference but the *resolved* object reports false, so the test and the `loadImage` call both take the
reference.

**A floor at the original size.** The result is measured, and if the "compressed" file is not
smaller the original is returned with the reason shown. A compress button that hands back a bigger
file is worse than no button, and after the pre-flight that is a measured risk rather than a
hypothetical one.

**Before/after is shown before committing**, per §2.3, because the trade is quality for bytes and
only the user knows which they want.

## 5. Metadata

`/Info` through `getMetaData` / `setMetaData`, which round-trip cleanly. XMP is a hand-written
`/Type /Metadata` stream — the pre-flight confirmed MuPDF neither creates nor updates one.

**Both are written, always.** Nothing keeps them in sync, so a document whose `/Info` says one title
and whose XMP says another is valid and will show different answers to different readers. Writing one
and leaving the other stale is how that happens, so the writer emits both from one source or neither.

Editable: title, author, subject, keywords, creator. `CreationDate` is preserved; `ModDate` is set on
export. Producer becomes get-margin, which is honest — this build did produce the file.

**A "strip all metadata" option**, which belongs next to the privacy page's promises rather than
buried in a properties dialog: it removes `/Info`, the XMP packet, and the document ID.

## 6. Find & replace

`buildQuadIndex` already extracts per-character quads for every page (Phase 2, Task 36). Find is a
search over that, with the normalisation §2.3 requires — PDFs break words across spans, use
ligatures, and space irregularly, so a naive `indexOf` misses most real matches.

Replace turns each hit into a text patch (§7), which is why find & replace is built *after* patching
exists rather than before. **Find alone ships first**, is useful alone, and de-risks the harder half:
a search that highlights matches across a document is valuable even if replace never lands.

Replace-all is one transaction, so it is one undo.

## 7. Text patching — last, and hedged

`PLAN.md` §2.4 has the pipeline in detail. What matters at design level:

**Addressing.** A run is `{pageId, blockIdx, lineIdx, originalTextHash}`. The hash is the guard: if
extraction shifts — a different MuPDF build, different options — the op **refuses to apply rather
than patching the wrong text**. Fail loudly; never silently mispatch.

**Cover and redraw**, not removal. An opaque rectangle in the sampled background colour, then new
text over it. Removal is redaction's job and has its own primitive; using `applyRedactions` for an
ordinary edit would be slower and would destroy more than intended.

**Three places it degrades, each surfaced rather than hidden:**

- **Background detection** samples around the run's bbox. Solid backgrounds work; gradients, images,
  and textures do not. High variance in the samples means low confidence, and low confidence warns
  instead of producing a visible white scar.
- **Font subsetting** means the embedded face usually contains only the glyphs already used. Typing
  `Ø` into a run whose subset lacks it has no glyph to draw. Detect the miss, fall back to a
  metric-compatible face (Liberation for Arial/Times/Courier), and **say so**. Silent substitution
  that looks slightly wrong is worse than a visible warning.
- **Fit** is within the line's bbox only. Wider replacement text offers shrink-to-fit, overflow, or
  truncate. Surrounding content is never pushed around.

**The UI communicates confidence per run** rather than presenting uniform editability. A run that can
be cleanly patched gets a normal affordance; a low-confidence one is marked. Every serious tool has
these limits; the difference is whether the user learns them before or after they trust one.

## 8. Font subsetting — attempted, and deferred again

**Not delivered in this phase, for a measured reason.** See the correction in findings 14 §6.

MuPDF's `subsetFonts()` turned out to work far better than §2.5 recorded — 88% off an export — but
only because §2.5 measured it on a font that had been registered and never drawn. Once glyphs are in
a content stream it shrinks the file dramatically **and renders the document wrong**: it rewrites the
font without keeping `/Widths` in step, so right-aligned text missed its box edge by 113 points and
four Phase 2 golden images moved. Text extraction kept working throughout, which is precisely what
makes it a trap.

`@pdf-lib/fontkit`'s own subsetter throws on `encode()` for this font, so the fallback path §2.5
assumed was available is not, at least not without work this phase did not budget.

Exports therefore still embed full faces, at 49–55% of a font's raw bytes. `subsetAttempt.test.ts`
pins the measurement, the failure, and the size of the prize, so the next attempt starts from
evidence rather than from the spec's assumption.

## 9. Out of scope, stated

- **Image and vector-art redaction** — see §2.
- **Paragraph reflow.** §2.4 chose line/span-level patching, and reflow is a multi-week subproject
  whose failure mode is silently mangling someone's document.
- **OCR.** Scanned pages have no text to patch, find, or redact. Phase 7.
- **Breaking encryption.** Removing a password needs the user password.
- **Digital signatures**, still. Phase 5 §11 applies unchanged.

## 10. Testing

- Redaction: every case the pre-flight covered, as a permanent test — including **independent-
  extractor verification in CI**, so the release gate is re-checked on every commit rather than once.
- Password: both silent-failure modes asserted to be caught by the self-check, and the permission bit
  table pinned.
- Compression: an already-small file is returned unchanged rather than grown.
- Metadata: `/Info` and XMP agree after a write; strip removes both.
- Stamping: tokens resolve per page, ranges apply, `behind` orders correctly, and a stamp lands
  correctly on rotated and offset-CropBox pages.
- Text patching: the hash guard refuses a shifted extraction; a missing glyph reports substitution
  rather than drawing nothing.
