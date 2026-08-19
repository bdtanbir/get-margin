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
| Active content | The user is told what was removed, including that form-field scripts go too | `test/features/strippedNotice.test.ts` |
| Failure | A render error costs its region, not the app, and names itself | `test/features/ErrorBoundary.test.ts` |
| Persistence | Edits are debounced, coalesced, pruned, and survive a rejected write | `test/stores/autosave.test.ts` |
| Persistence | Restoring is offered, never automatic; declining deletes the record before the prompt clears | `test/features/RestorePrompt.test.ts`, `e2e/autosave.spec.ts` |
| Persistence | An older stored schema migrates; a newer one is refused with a message | `test/features/RestorePrompt.test.ts` |
| Persistence | Edits survive a real page reload and come back on request | `e2e/autosave.spec.ts` |
| Privacy | Every claim on the privacy page matches what the code stores | `test/features/PrivacyPage.test.ts` |
| Reach | Modal surfaces trap focus, close on Escape, and return focus | `test/lib/useFocusTrap.test.ts`, `test/features/a11y.test.ts` |
| Reach | Every icon-only control has an accessible name | `test/features/a11y.test.ts` |
| Reach | Every tool in the rail is reachable from the palette | `test/features/CommandPalette.test.ts` |
| Scale | 300 pages: ~300 ms to first page, ~36 ms/scroll step, 215 MB heap | `e2e/perf.spec.ts`, findings 10 |
| Scale | The bitmap budget scales with device memory and degrades to the shipped constant | `test/lib/memoryBudget.test.ts` |
| Scale | A merge that would cross the total byte budget is refused | `test/lib/limits.test.ts`, `test/features/merge.test.ts` |
| Touch | Pinch, pan, palm rejection, and no jump when a finger joins or leaves | `test/features/useGestures.test.ts` |
| Touch | Page selection works on the phone shell | `test/features/PageGrid.test.ts`, `e2e/pages.spec.ts` |

879 unit tests, 51 e2e across desktop and phone viewports, clean `tsc` and `vue-tsc`, clean build.

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

## The honest call on the milestone

The MVP is **feature-complete and not yet verified**. Everything in `PLAN.md` §7's Phase 4 line is
built and covered by tests that run on every commit, and the app ships as a pure static frontend
with no backend, database, or accounts, exactly as the milestone specifies.

But "shippable" for a tool whose entire promise is *your files never leave your device and the file
you get back opens correctly everywhere* cannot be claimed on the strength of a test suite that has
never opened one of its own exports in Acrobat, or run its touch gestures on a phone. Those two
checks are the gate. Until someone does them, this is a release candidate.
