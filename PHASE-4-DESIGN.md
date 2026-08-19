# Phase 4 — MVP Hardening: Design

**Status:** design. The executable task breakdown lands separately in `PLAN-PHASE-4.md`.

**Milestone (PLAN.md §7):** ▶ **Shippable MVP.** Ships as a pure static frontend — no backend, no database, no accounts, no per-user hosting cost.

**Predecessor:** Phase 3 complete and merged (`96b3563`) — 728 passing tests, 35 e2e, clean `tsc`/`vue-tsc`, 13 reviewed goldens.

**Pre-flight measurements:** `docs/findings/09-phase-4-preflight.md`.

---

## 0. This phase is wider than the others, so it is sequenced

Phases 1–3 each built one subsystem. Phase 4's list in `PLAN.md` §7 is eleven separate concerns, plus two items earlier phases explicitly deferred here. Treating that as one undifferentiated push is how a release gate turns into a month of half-finished work.

It is therefore split into **four tranches**, ordered by what "shippable" actually requires. Each tranche is independently useful and leaves the app releasable-in-principle at its end.

| Tranche | Contents | Why this order |
|---|---|---|
| **4A — Trust** | `/JS` + `/OpenAction` stripping · error boundaries · privacy page | The things whose absence would make shipping *irresponsible* rather than merely rough. A hostile PDF passing through the editor unchanged is a user-harm risk; an unhandled exception with no boundary loses work silently. |
| **4B — Not losing work** | IndexedDB autosave · crash recovery · schema migration wired | The single most damaging failure a browser editor has: a tab crash after an hour of annotation. Depends on 4A's error boundaries to know when to save. |
| **4C — Reach** | a11y pass · onboarding empty state · ⌘K palette | Making the thing usable by everyone and discoverable by newcomers. Independent of 4A/4B. |
| **4D — Scale and touch** | 300-page perf pass · memory-pressure handling · mobile gestures (pinch/pan/palm rejection) · phone page selection | Polish that needs real measurement, and the one Phase 3 gap that is a genuine capability hole on phones. |

**Deliberately deferred *again*, with reasons:**

- **Font subsetting** (deferred from Phase 2 §0). It is a size optimisation, not a capability, and it adds `pdf-lib` + `@pdf-lib/fontkit` to a write path that has just absorbed a schema change and three assembly tiers. The measured cost is ~66 KB per embedded family, which a static-hosted MVP can carry. Revisit when there is a size complaint, not before.
- **Snapping and alignment guides** (deferred from Phase 2 §0). Phase 2 deferred it "to tune thresholds against real usage", and there still is not any. Shipping the MVP is what produces that usage.

Both are recorded in `PLAN.md` §7 rather than quietly dropped.

---

## 1. Tranche 4A — Trust

### 1.1 Active-content stripping

Measured (`09-phase-4-preflight.md`): all four vectors — catalog `/OpenAction`, catalog `/Names /JavaScript`, and `/AA` on both the catalog and each page — can be deleted, and the export path's existing `compress,garbage=compact` collects the orphaned objects so the **script text is genuinely gone from the bytes**, not merely unlinked.

**Where:** in the write path, applied to every export. `replay` already opens the pristine source and replays onto it, so it is the one place every downloaded byte passes through. Not on open: MuPDF does not execute JavaScript while rendering, so the risk is not to this app — it is the user editing a hostile file and passing it on.

**Always on, not a setting.** A checkbox here is a question most users cannot answer, and the safe default is the only defensible one for a consumer editor.

**The cost is real and gets said out loud.** A source document whose form fields carry validation scripts loses them. That belongs in the UI — a note on the download surface when a document actually contained active content — not only in a commit message. Detecting it is the same traversal that removes it, so saying so is nearly free.

### 1.2 Error boundaries

Vue's `onErrorCaptured` plus a top-level `app.config.errorHandler`. Two boundaries, because they fail differently:

- **Around the page viewport.** A render or overlay error must not blank the whole app. Shows a recoverable panel and leaves the document open.
- **At the app root.** Last resort. Its one job is to make the user's work recoverable rather than lost, which is why 4B's autosave lands right after: the boundary's message is only honest if the edits really are saved.

A boundary that swallows an error silently is worse than no boundary. Every caught error is recorded so the surfaced message can name what failed.

### 1.3 Privacy page

The product's central claim is that files never leave the browser. A static page stating what is and is not stored, what runs locally, and what the one piece of persistence (4B's autosave) actually keeps. It must be *accurate*, so it is written after 4B's design is settled and re-checked against it.

---

## 2. Tranche 4B — Not losing work

### 2.1 What is stored

**The `EditDocument`, not the source PDF.** Measured reasoning in the pre-flight: an `EditDocument` is tens of KB except for image and signature payloads, which are already capped and re-encoded. The source is up to 150 MB, and keeping a copy of every document the user has ever opened is a privacy cost the "never leaves the browser" promise does not license on its own.

Restoring therefore means: *re-pick the file, and your edits come back*. `EditDocument.sources[id].hash` has held a SHA-256 per source since Phase 3's schema v2, so matching a restored edit to a re-picked file is already possible.

### 2.2 Shape

Dexie (already a dependency, from Phase 2's signature store). One record per opened document, keyed by the primary source's hash, holding the serialised `EditDocument`, a timestamp, and the file name for display.

Writes are **debounced and coalesced** — an autosave per keystroke would be a write per keystroke. The trigger is the same edit-store subscription the UI already has.

`migrateEditDocument` becomes load-bearing here: a record written by an older build must be lifted on read, and one written by a *newer* build must be refused rather than mangled. Both already exist and are tested; this is what wires them to a real caller.

### 2.3 Restoring

On opening a file whose hash matches a stored record, offer to restore — never restore silently. Silent restoration means a user who deliberately started over finds their old annotations back with no explanation. The offer states when the edits were made.

Records are pruned by age and count, so storage does not grow without bound.

---

## 3. Tranche 4C — Reach

**A11y pass.** Keyboard reachability for every tool and page action, focus management on modals (the signature, split, and crop surfaces all trap focus today only by accident), visible focus rings, and an audit of the overlay's ARIA. The page grid is already `role="option"`/`aria-selected` but has no `role="listbox"` parent.

**Onboarding empty state.** The drop zone states what the app does and that files stay local. Currently it says "Open a PDF" and little else.

**⌘K palette.** Every tool and page action by name. Deliberately last in this tranche: it is an accelerator over commands that must already exist and be reachable, so it is built on top of the a11y work rather than beside it.

---

## 4. Tranche 4D — Scale and touch

**Perf pass on 300 pages.** Phase 0 measured read throughput (827.9 pages/sec) and Phase 2 measured export (~23 ms for 50 objects across 300 pages). What is unmeasured is the in-browser experience: scroll smoothness, bitmap cache behaviour at the 50-megapixel bound, and time-to-interactive on a large document. Measure first, then decide what to change — the caps are all hand-chosen constants and at least one is probably wrong.

**Memory-pressure handling.** Every bound today is a fixed constant. `navigator.deviceMemory` exists on Chrome and Android but not Safari or Firefox, so adaptation must degrade to the current constants rather than depend on it. Includes Phase 3's recorded hole: a merged file's bytes are held until the document closes.

**Mobile gestures.** Pinch-zoom, pan, and palm rejection on the page surface, which currently has none of them.

**Phone page selection.** Phase 3's genuine capability gap: rotate and delete are desktop-only because the phone's pages panel closes when a thumbnail is tapped. Needs a touch-specific affordance — a per-tile select control, or a select mode — rather than a gesture invented at test-writing time.

---

## 5. Testing

| Layer | What |
|---|---|
| Unit | Every stripping vector removed **and the raw script text absent from the output bytes** |
| Unit | Autosave debounces, migrates on read, refuses a newer schema, and prunes |
| Component | Error boundary catches, surfaces a named message, and does not blank the app |
| Component | Restore is offered, never automatic, and declining leaves the document clean |
| e2e | Open a hostile fixture, edit, download, and assert the exported bytes carry no script |
| e2e | Edit, reload the page, re-pick the file, restore, and find the edits |
| Measured | 300-page scroll and memory, recorded in `docs/findings/` as numbers, not adjectives |

The stripping e2e is the one that matters most: it is the only test that exercises the whole path a hostile file actually takes.

---

## 6. Explicitly out of scope

- **Font subsetting** and **snapping** — deferred again, see §0.
- **Backend anything.** The MVP ships static; conversion is Phase 7.
- **Real redaction.** Phase 6, and deliberately not conflated with whiteout or crop, both of which say plainly that they only hide.
- **Forms.** Phase 5.
