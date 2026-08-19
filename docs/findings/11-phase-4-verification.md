# Phase 4 verification record — the MVP gate

Task 65. Phase 4 is the last phase before `PLAN.md` §7's **▶ Shippable MVP**, so this record has to
answer a question the earlier ones did not: *is it shippable?*

## The short answer

**Everything Phase 4 set out to build is built, and one class of verification is outstanding: a
human on real hardware.** That is not a formality here — it is the only remaining check on the two
claims the product is sold on (files never leave the device; exports open correctly elsewhere) and
on the one platform this project committed to and cannot emulate (a mid-range phone).

## What is verified automatically, on every commit

| Area | Check | Where |
|---|---|---|
| Active content | `/OpenAction`, `/Names /JavaScript`, and catalog + page `/AA` are removed from every export | `test/write/sanitize.test.ts` |
| Active content | The script **text** is absent from the output bytes, not merely unlinked | `test/write/sanitize.test.ts` |
| Active content | Stripping defeats the byte-identical pass-through for a hostile file, but not for a clean one | `test/write/sanitize.test.ts`, `e2e/sanitize.spec.ts` |
| Active content | Annotation `/A` chains (`/Launch`, `/SubmitForm`, `/JavaScript`) and widget `/AA` are removed, including behind a benign `/Next` hop | `test/write/sanitize.test.ts` |
| Active content | An ordinary `/URI` link survives -- the sweep is a denylist, so links are not collateral | `test/write/sanitize.test.ts` |
| Active content | The user is told what was removed, including that form-field scripts go too | `test/features/strippedNotice.test.ts` |
| Failure | A render error costs its region, not the app, and names itself | `test/features/ErrorBoundary.test.ts` |
| Persistence | Edits are debounced, coalesced, pruned, and survive a rejected write | `test/stores/autosave.test.ts` |
| Persistence | Restoring is offered, never automatic; declining deletes the record before the prompt clears | `test/features/RestorePrompt.test.ts`, `e2e/autosave.spec.ts` |
| Persistence | An older stored schema migrates; a newer one is refused with a message | `test/features/RestorePrompt.test.ts` |
| Persistence | Edits survive a real page reload and come back on request | `e2e/autosave.spec.ts` |
| Privacy | Every claim on the privacy page matches what the code stores | `test/features/PrivacyPage.test.ts` |
| Privacy | Every key of the autosave record is explicitly accounted for, so a new one cannot appear undisclosed | `test/features/PrivacyPage.test.ts` |
| Reach | Modal surfaces trap focus, close on Escape, and return focus | `test/lib/useFocusTrap.test.ts`, `test/features/a11y.test.ts` |
| Reach | Every icon-only control has an accessible name | `test/features/a11y.test.ts` |
| Reach | Every tool in the rail is reachable from the palette | `test/features/CommandPalette.test.ts` |
| Scale | 300 pages: ~300 ms to first page, ~36 ms/scroll step, 215 MB heap | `e2e/perf.spec.ts`, findings 10 |
| Scale | The bitmap budget scales with device memory and degrades to the shipped constant | `test/lib/memoryBudget.test.ts` |
| Scale | A merge that would cross the total byte budget is refused | `test/lib/limits.test.ts`, `test/features/merge.test.ts` |
| Touch | Pinch, pan, palm rejection, and no jump when a finger joins or leaves | `test/features/useGestures.test.ts` |
| Touch | Page selection works on the phone shell | `test/features/PageGrid.test.ts`, `e2e/pages.spec.ts` |

890 unit tests, 51 e2e across desktop and phone viewports, clean `tsc` and `vue-tsc`, clean build.

### One gap this record found, and closed

Auditing against the spec rather than against the plan turned up a real hole. `PLAN.md` names three
vectors -- `/JS`, `/OpenAction`, **`/Launch`** -- and the sanitizer as first written covered the
catalog and the page dictionary only. `/Launch` does not live there. It lives on annotations: a link
hotspot whose `/A` runs a file, or a form widget whose `/AA` fires a keystroke script.

The failure mode was the bad one. Such a file reported *nothing stripped*, which meant it also
satisfied the byte-identical pass-through tier -- so an unedited hostile PDF was handed straight back
to the user, intact and unmentioned, by the code path written to prevent exactly that. The probe is
in the commit message; the regression test is `defeats pass-through for a file whose only payload is
on annotations`.

Two design notes, since both directions were available:

- **A denylist, not an allowlist.** The app writes its own `/URI` and `/GoTo` links, and real
  documents are full of legitimate navigation; an allowlist would have destroyed every hotspot in
  every table of contents. Removed: `JavaScript`, `Launch`, `SubmitForm`, `ImportData`, `Rendition`,
  `GoToE`. Kept: `GoToR` and `Named`, which navigate without running anything.
- **The whole `/Next` chain goes, not the offending hop.** `/S /URI` with a `/Next` of `/S /Launch`
  reads as an ordinary link from its first dictionary. Keeping the benign prefix of an action built
  to deceive means trusting the shape of a hostile file.

Still not stripped, deliberately: embedded file attachments (`/Names /EmbeddedFiles`) and XFA. Both
are legitimate features whose removal is real data loss, and neither executes on its own.

## Outstanding — and what each one blocks

### 1. Cross-viewer verification (Acrobat, Preview, Chrome) — BLOCKS THE MILESTONE

Unchanged from Phases 2 and 3: no GUI is available to any agent here. `PLAN.md` §7 names all three
viewers in the Phase 2 milestone, and every phase since has added things only a viewer can confirm.

Files to open, accumulated across the phases:

| File | What it proves |
|---|---|
| `evidence/phase-2-all-kinds.pdf` | Every object kind renders, and annotations stay editable |
| `evidence/phase-2-rotated-90.pdf`, `phase-2-offset-cropbox.pdf` | Coordinates hold on awkward pages |
| `evidence/phase-3-pageops.pdf` | Reorder, delete, rotate, crop |
| `evidence/phase-3-merged.pdf` | **Merged-in pages keep their annotations** |

Matrices: `06-phase-2-verification.md`, `08-phase-3-verification.md`.

### 2. A real phone — BLOCKS THE MILESTONE

An emulated viewport shares the desktop's CPU and memory: it tests layout, not capacity, and not
touch. Specifically unverified:

- the pinch/pan/palm gestures against actual fingers,
- the 215 MB heap measurement on a device with 3–4 GB shared with the whole system,
- whether `navigator.deviceMemory` reports something sensible there, and whether the budget it
  produces is right,
- the per-tile select control at thumb size.

### 3. Smaller, and not blocking

- **A merged file's bytes are held until the document is closed.** Freeing them safely needs a
  "beyond the undo horizon" test that is not cheap to compute, and being wrong leaves a redo that
  cannot render. The total is now bounded at 300 MB instead (findings 10).
- **Font subsetting** and **snapping** — deferred from Phase 2 to Phase 4 and now deferred again,
  with reasons, in `PHASE-4-DESIGN.md` §0. Neither is a capability; both are optimisations that
  want real usage to tune against.
- **Adopting a document's existing links** into the edit store — Phase 2's Task 34 Step 5, still
  open. The v2 schema makes it tractable.
- **Bookmarks and page labels are lost across a merge** — stated in the merge UI.
- **A document with heavy annotations at 300 pages** is unmeasured; the perf fixture is 300
  near-empty pages.

## A second gap, found while auditing Phase 4 after Phase 5 shipped

The sanitizer hole above was found by reading Phase 4 against the spec. This one was found by
reading it against the code that came *after* it, and it is the more interesting failure.

Phase 5 added `fieldValues` to the edit document. That document is what autosave writes to
IndexedDB — so from the moment forms shipped, **the answers someone types into a tax form were being
persisted to disk**, and the privacy page went on listing three stored things and asserting that
"anything identifying you" was not among them. The claim was true when written and false by the time
anyone read it.

Also wrong, and wrong from the start rather than by drift: the record has always carried the
**file name** (`SavedEdit.name`), which the page never mentioned. `2024-tax-return-jane-doe.pdf` is
personal data.

Both are now named, along with the honest correction that anything the *user* writes — text they
add, answers they fill in — is stored until they clear it. The "Clear everything stored" button
already covered it; the page simply did not say so.

The structural fix matters more than the wording. Every existing test pinned a claim the page
already made, so none of them could notice a new category of stored data appearing. There is now a
map from every key of the autosave record and the edit document to whether the page must mention it
and why — checked against the schema's **runtime** keys, so adding a field fails the suite until
someone decides. Verified by adding a key and watching it fail.

The general form, which is the same lesson as the sanitizer gap: **a test that enumerates the
claims you made cannot tell you about the claim you should have made.** Guard the boundary, not the
prose.

## The honest call on the milestone

The MVP is **feature-complete and not yet verified**. Everything in `PLAN.md` §7's Phase 4 line is
built and covered by tests that run on every commit, and the app ships as a pure static frontend
with no backend, database, or accounts, exactly as the milestone specifies.

But "shippable" for a tool whose entire promise is *your files never leave your device and the file
you get back opens correctly everywhere* cannot be claimed on the strength of a test suite that has
never opened one of its own exports in Acrobat, or run its touch gestures on a phone. Those two
checks are the gate. Until someone does them, this is a release candidate.
