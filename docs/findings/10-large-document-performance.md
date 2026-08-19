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

**Nothing yet, deliberately.** The two timing numbers need no work. The memory number does, and it
is Task 62's subject: the cap is a fixed constant that does not know what device it is on. Recording
the number first is what makes that a targeted change rather than a guess.

## Not measured

- **A real phone.** An emulated viewport shares the desktop's memory and CPU; it tests layout, not
  capacity. This remains a human step, as in Phases 2 and 3.
- **`performance.memory` off Chromium.** Safari and Firefox do not expose it, so there is no number
  from those engines — which is also why Task 62 cannot depend on reading memory at runtime.
- **A document with heavy annotations.** This fixture is 300 near-empty pages; the interaction
  between many objects and the bitmap cache is untested at this scale.
