# Findings: a 300-page document in the browser

Measured for Phase 4 Task 61, **before** changing any cap. Every limit in this app is a
hand-chosen constant, and tuning them against imagined conditions is how they end up wrong.

Method: `apps/web/e2e/perf.spec.ts`, real Chromium via Playwright against the built app, opening the
generated `large-300p.pdf` fixture. Desktop project only — the phone project shares the same engine
and running it twice doubles the slowest spec for no extra information.

Environment: Apple Silicon, Chromium via Playwright, production build (`vite build` + `preview`).

## Results

| Measure | Value |
|---|---|
| Pages | 300 |
| Time to first page visible | **~300 ms** |
| Time to the page grid populated | ~15 ms after that |
| Scroll through 50 pages | ~1.8 s (≈ **36 ms per page-height step**) |
| JS heap after that scroll | **215 MB** |

Two runs agreed within noise (298/321 ms, 1701/1851 ms, 215 MB both times).

## What this says

1. **Opening is not a problem.** 300 ms to a visible first page on a 300-page document, because the
   viewer renders the anchor page first and everything else is virtualized behind it. Phase 0's
   827.9 pages/sec was raw throughput; this is what the user actually waits for, and it is
   dominated by worker boot and the first render rather than by page count.

2. **Scrolling holds up.** ~36 ms per page-height step, including the render queue keeping up. That
   is a little over two frames at 60 Hz per whole-page jump — noticeable if you look for it, fine in
   practice, and the virtualizer is genuinely unmounting: page 1 is *gone from the DOM* after
   scrolling fifty pages away, which the spec now asserts.

3. **Memory is the real ceiling, and it is at its cap.** 215 MB of JS heap sits right against
   `bitmapCache.ts`'s 50-megapixel bound (≈200 MB at 4 bytes/pixel) plus the document itself. On a
   desktop that is unremarkable. On a mid-range phone with 3–4 GB shared between the whole system
   it is the number that would end the session, and `lib/limits.ts` has flagged its caps as
   unvalidated on mobile hardware since Phase 1.

## What was changed as a result

The two timing numbers needed no work. The memory number produced two changes, and one deliberate
non-change.

1. **The bitmap cap is now resolved per device** (`lib/memoryBudget.ts`), scaling with
   `navigator.deviceMemory` between a 12-megapixel floor and a 100-megapixel ceiling. 4 GB lands
   exactly on the previous constant, so nothing regresses on the hardware it was chosen for, and a
   device that does not report its memory — Safari, Firefox — gets that same constant rather than
   whatever a careless fallback would have produced.

2. **The total bytes of all open source files is now bounded** at 300 MB
   (`MAX_TOTAL_SOURCE_BYTES`). `MAX_BYTES` bounded one file; nothing bounded the sum, so merging
   several large documents grew memory without limit. A merge that would cross it is refused with a
   message that says what to do instead.

3. **A merged file's bytes are still not freed while the document is open**, unchanged from Phase 3.
   The plan permitted dropping them once a source was "beyond the undo horizon"; establishing that
   safely means walking Immer patch values in both the undo and redo stacks for source references,
   and being wrong leaves a redo that cannot render or export. That is not a cheap condition, so it
   was not implemented — refusing the merge that would cross the budget is the safe half of the
   problem and the half worth having.

## Not measured

- **A real phone.** An emulated viewport shares the desktop's memory and CPU; it tests layout, not
  capacity. This remains a human step, as in Phases 2 and 3.
- **`performance.memory` off Chromium.** Safari and Firefox do not expose it, so there is no number
  from those engines — which is also why Task 62 cannot depend on reading memory at runtime.
- **A document with heavy annotations.** This fixture is 300 near-empty pages; the interaction
  between many objects and the bitmap cache is untested at this scale.


## Addendum — the fill overlay's cost on a formless document

Re-measured while auditing Phase 4 after Phase 5 shipped, because forms added a per-page worker call
that this budget never accounted for.

`FieldLayer` asks for a page's fields on mount, and enumerating fields meant loading a page in the
worker. On a 300-page report with no form at all, that is a page load per page for an answer that is
always empty — and it showed: **41 ms per scroll step against the 36 ms measured here originally.**

`listFields` now answers from the catalog first. A document with no `/AcroForm` has no form fields by
the format's own definition — widgets outside it are non-conformant and no viewer treats them as a
form — so one lookup replaces the page load.

| | ms/scroll step |
|---|---|
| Phase 4, before forms existed | 36 |
| Forms shipped, no catalog check | 41 |
| With the check | 38 |

38 against 36 is within the run-to-run variation of a single measurement; what is gone is the
systematic cost, which grew with page count. Worth recording as a pattern rather than an incident:
**a feature that asks a question per page is a feature that must be able to answer it without
opening one.**
