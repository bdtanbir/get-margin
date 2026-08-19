# Findings: Phase 4 (MVP hardening) pre-flight

Measured after Phase 3 merged, before Phase 4 was designed.

## Active content can be stripped, and the bytes actually go

A PDF was built carrying four kinds of active content, then stripped and re-inspected:

| Vector | Where | Before | After |
|---|---|---|---|
| `/OpenAction` | Catalog — runs when the file opens | present | gone |
| `/Names /JavaScript` | Catalog — document-level scripts | present | gone |
| `/AA` | Catalog — additional actions (e.g. will-close) | present | gone |
| `/AA` | Page — additional actions (e.g. page-open) | present | gone |
| **Raw `app.alert` string anywhere in the file** | — | **present** | **gone** |

That last row is the one that matters. Deleting a key only unlinks the object; the script text would
still sit in the file and be recoverable by anyone reading the bytes. `saveToBuffer` with the
existing `SAVE_OPTIONS` (`compress,garbage=compact`) collects the orphans, so the strings are
genuinely removed. **No new save options are needed — the ones the export path already uses do it.**

Primitives used, all present in mupdf 1.28.0: `doc.getTrailer()`, `obj.get(...path)`,
`obj.delete(key)`, `obj.forEach()`.

### Where stripping belongs, and what it costs

Export, not open. MuPDF does not execute JavaScript while rendering, so an opened file is not
dangerous to *this* app; the risk is the user editing a hostile PDF, downloading it, and passing it
on. The export path already opens the pristine source and replays onto it, so that is the one place
every downloaded byte passes through.

**Stated cost:** a source document whose form fields carry validation scripts loses them. For a
consumer PDF editor that is the right default, but it is a real behaviour change and belongs in the
UI, not only in a commit message. Phase 5's own generated fields do not need JavaScript — Phase 0
measured that MuPDF auto-generates `/AP` appearance streams, including two-state checkboxes
(`docs/findings/04-raw-objects.md`).

## What is already bounded, and what is not

| Resource | Bound | Where |
|---|---|---|
| Rendered bitmaps | 50 megapixels (~200 MB at 4 bytes/px) | `lib/bitmapCache.ts` |
| Undo history | 200 entries **and** 64 MB of patch payload | `stores/edits.ts` |
| Opened file | 150 MB | `lib/limits.ts` |
| Page count | 800 | `lib/limits.ts` |
| **Merged source bytes** | **unbounded** — one full copy per added file | `workers/pdfService.ts` |
| **Open document handles** | primary + 1 secondary | `workers/pdfService.ts` |

Every cap is a fixed constant chosen by hand; none adapts to the device. `navigator.deviceMemory`
is available on Chrome and Android but not Safari or Firefox, so any adaptation has to degrade to
the current constants rather than depend on it.

The unbounded row is Phase 3's recorded limitation: `dropSource` exists but cannot be called
automatically while undo/redo can bring a merged file's pages back.

## Persistence: what is worth storing

`EditDocument` is small — geometry, colours, and text, in the low tens of KB — **except** for image
and signature payloads, which are the encoded bytes themselves. An imported image is capped at
2000px and re-encoded (JPEG q0.85 unless it has alpha), so a page with several photos is single-digit
megabytes, not tens.

The source PDF is up to 150 MB and is **not** worth storing: re-picking the file costs the user one
click, and keeping a copy of every document they have ever opened in browser storage is a privacy
cost the spec's "never leaves the browser" promise does not license by itself. Matching a restored
edit to a re-picked file is already possible — `EditDocument.sources[id].hash` holds the SHA-256 of
each source, recorded since Phase 3's schema v2.

`migrateEditDocument` becomes load-bearing here rather than forward-looking: a restored document may
predate the current schema.
