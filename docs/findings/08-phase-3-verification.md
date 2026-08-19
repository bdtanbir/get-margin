# Phase 3 verification record

Task 51. Companion to [`07-phase-3-preflight.md`](./07-phase-3-preflight.md), which recorded what
was measured *before* the phase was designed.

## Status: cross-viewer verification is OUTSTANDING

Same reason as Phase 2 ([`06-phase-2-verification.md`](./06-phase-2-verification.md)): no agent can
open Acrobat, Preview, or Chrome. Every row below is `NOT VERIFIED` rather than inferred from the
automated coverage.

## What IS verified, automatically, on every commit

| Check | Where |
|---|---|
| Crop is Convention A — the box the user drew, not its vertical mirror | `test/write/pageBoxes.test.ts`, on origin-zero, offset-CropBox and quarter-turned pages |
| Rotation ADDS to a page's existing `/Rotate` rather than replacing it | `test/write/pageBoxes.test.ts` |
| An unedited export is byte-identical to the file that was opened | `test/write/assemble.test.ts`, `e2e/download.spec.ts` |
| A single-source reorder keeps existing annotations and links | `test/write/assemble.test.ts` |
| **A merge keeps existing annotations and links** | `test/write/assemble.test.ts`, `test/write/pageOpsSuite.test.ts` |
| Reorder, extract, and repeat-a-page produce the right pages in the right order | `test/write/assemble.test.ts` |
| Export is deterministic and never mutates a source's bytes | `test/write/pageOpsSuite.test.ts` |
| Every `ObjectKind` still has a writer after the schema change | `test/write/pageOpsSuite.test.ts` |
| Rendered output matches reviewed goldens across four fixtures plus a merge | `test/golden/pageops-*.png` |
| A page renders from the source it belongs to, not the primary document | `test/workers/pdfService.test.ts` |
| Deleting a page takes its objects and restores them together on undo | `test/stores/edits.test.ts` |
| v1 edit documents migrate, and a newer schema is refused loudly | `test/write/migrate.test.ts` |
| `replay` lifts a v1 document rather than failing on its missing `sources` | `test/write/migrate.test.ts` |

The `pageops-cropped.png` golden is deliberately a **mirror detector**: it crops to the half of the
page the fixture's text sits in, so a correct crop renders the label and a vertically mirrored one
renders a blank band.

`pageops-offset-cropbox.png` is blank, and that is correct — the fixture's own page renders zero
dark pixels because its content lies outside its CropBox. Checked directly rather than assumed.

## Files to open

| File | What to look at |
|---|---|
| [`evidence/phase-3-pageops.pdf`](./evidence/phase-3-pageops.pdf) | Reordered and deleted pages, one rotated, one cropped |
| [`evidence/phase-3-merged.pdf`](./evidence/phase-3-merged.pdf) | Two documents merged, with annotations on the merged-in pages |

## The matrix — fill this in

| Operation | Acrobat | Preview | Chrome |
|---|---|---|---|
| Page order matches the editor | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| Rotated page displays rotated | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| Cropped page shows the kept region, not its mirror | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| Merged document shows every page from both files | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| **Annotations on merged-in pages are still there** | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| Split parts each open independently | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |

**The row that matters most is the annotations one.** `graftPage` copies page content and drops
`/Annots` entirely; the write path grafts them back explicitly, and a viewer is the only place a
user would notice if that ever stopped working.

## Outstanding

1. **Page management on the phone shell.** Selection-based actions — rotate and delete — are
   desktop-only. The phone's pages panel is a full-screen modal that closes when a thumbnail is
   tapped (deliberate Phase 1 behaviour, so tapping a page navigates rather than jumping the
   viewport behind an open overlay), which makes tap-to-select unreachable: the grid carrying the
   controls is gone by the time a selection exists. `PHASE-3-DESIGN.md` §6 called for a
   touch-specific affordance and this phase did not build one. Merge, split, and crop *do* work on
   phone. Three e2e tests are scoped desktop-only and say why.
2. **Bookmarks and page labels are lost across a merge.** `graftPage` carries no document-level
   structure. Stated in the merge UI rather than dropped silently.
3. **Open-document handles during a merge.** `PdfService` keeps the primary document open plus at
   most one secondary, swapping the secondary as pages from different files are rendered. A merge of
   two files therefore costs two handles; a grid spanning many files will reopen as it scrolls.
   That is a deliberate trade-off — a parsed handle is the expensive resource, the bytes are not —
   and worth measuring if merges get wide.

   Found while writing this record: `render()` previously always used the primary document, so a
   merged-in page rendered whatever the primary happened to have at that index — silently the wrong
   page rather than an error. Render requests now name their source, pinned by
   `test/workers/pdfService.test.ts`.
4. **A merged file's bytes are held until the document is closed.** `PdfService.dropSource` exists
   but is deliberately not called automatically: adding a file is an undoable `insertPages` op, so
   undo removes its pages and redo brings them back — freeing the bytes in between would leave a
   redo that cannot render or export. Merging several large files therefore grows memory for the
   session. An explicit "remove this file" action could drop them sooner, but it would have to
   discard that source's history as well.

5. **Adopting a document's existing links into the edit store** — Phase 2's Task 34 Step 5, still
   deferred. The v2 schema makes it tractable.
6. **In-browser export throughput and mid-range phone limits**, unchanged from Phase 2.
