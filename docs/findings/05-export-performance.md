# Findings: export (write-path) performance

Measured during Phase 2 Task 39. Phase 0 measured the READ path (827.9 pages/sec at 1.0× for
rendering) but never measured export, and the plan called for a number rather than an assumption.

## Method

`packages/pdf-core/src/write/index.ts`'s `replay()` called directly in Node, against the generated
fixture `large-300p.pdf` (300 pages, 651 KB). Objects are alternating rects and ellipses with
stroke, and a fill on every third, spread evenly across the document. Five runs per configuration;
the median is reported. `onProgress` counts the pages actually written.

Environment: Node v20.16.0, mupdf 1.28.0, Apple Silicon (darwin 24.6.0).

## Results

| Objects | Pages written | Median | Min | Max | Output |
|---:|---:|---:|---:|---:|---:|
| 50 | 50 | 23 ms | 22 ms | 32 ms | 638 KB |
| 300 | 288 | 41 ms | 40 ms | 42 ms | 682 KB |
| 900 | 300 | 56 ms | 50 ms | 65 ms | 788 KB |

The plan's stated scenario — a 300-page document with 50 objects spread across it — exports in
**~23 ms**, roughly 2,200 written-pages/sec.

## What this means

1. **Export is not the bottleneck, and the progress UI is precautionary.** Even the 900-object case
   finishes in under a tenth of a second. `TopBar.vue` only shows a determinate count for documents
   of 20 pages or more; for content-stream objects that indicator will essentially never be seen.
   It is kept because Task 31's fonts and Task 32's images are the expensive cases and are not
   represented here — a document embedding several 66 KB font programs or multi-megabyte images
   costs far more than the geometry measured above.

2. **Cost tracks pages touched, not objects.** Going from 50 to 900 objects (18×) costs 2.4× wall
   clock, because the per-page `loadPage`/`destroy` cycle dominates and pages saturate at 300.
   Adding more marks to pages already being written is nearly free.

3. **The 120 s export timeout in `pdfClient.ts` has enormous headroom** — three orders of magnitude
   over the worst case measured here. It exists to stop a pathological document leaving the
   Download button spinning forever, not to bound normal work.

## Not measured

- **Fonts and images.** The dominant size and time contributors in a real annotated document.
  Task 31 measured font embedding at 57–65% of raw bytes but not its time cost.
- **In-browser (WASM) throughput.** These numbers are Node. The browser runs the same WASM build in
  a worker; Phase 0 found read-path throughput comparable, but export has not been measured there.
- **Mid-range phone.** `lib/limits.ts` still flags its caps as unvalidated on mobile hardware.
