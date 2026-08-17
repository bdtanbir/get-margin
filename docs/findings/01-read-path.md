# Findings: MuPDF.js read path

Engine: mupdf@1.28.0 (plan assumed `^1.26.0` — some API drift found and documented below)
Machine: Apple M1 Pro, 16GB RAM, node v23.7.0 (macOS/Darwin 24.6.0)

## Q1 — ArrayBuffer to pixels

Real, verified call sequence (matches `packages/pdf-core/node_modules/mupdf/dist/mupdf.d.ts`):

```ts
import * as mupdf from 'mupdf'

const doc = mupdf.Document.openDocument(
  new Uint8Array(buf),      // Buffer | ArrayBuffer | Uint8Array | Stream | string
  'application/pdf',        // magic?: string
)                            // -> Document (actually a PDFDocument instance for PDF input)

const page = doc.loadPage(0) // -> Page (actually a PDFPage instance)

const pix = page.toPixmap(
  mupdf.Matrix.scale(2, 2),        // matrix: Matrix ([a,b,c,d,e,f])
  mupdf.ColorSpace.DeviceRGB,      // colorspace: ColorSpace
  false,                            // alpha?: boolean
  true,                             // showExtras?: boolean (PDFPage overload only)
)                                    // -> Pixmap

const pixels = pix.getPixels()      // -> Uint8ClampedArray, row-major, RGB (3 bytes/px, no alpha)
const stride = pix.getStride()      // bytes per row (measured: 3672 for a 1224px-wide RGB pixmap = 1224*3)
const png = pix.asPNG()             // -> Uint8Array, encoded PNG bytes
```

Measured for `simple-text` page 0 (612×792) at scale 2: pixmap 1224×1584, 5,816,448 bytes total, 3 bytes/px, stride 3672.

`PDFPage.toPixmap` has a wider signature than base `Page.toPixmap`: `(matrix, colorspace, alpha?, showExtras?, usage?: string, box?: PageBox)`. `loadPage()`/`openDocument()` return the PDF-specific subclasses (`PDFPage`, `PDFDocument`), which carry extra methods not on the generic `Page`/`Document` base (e.g. `getTransform()`, `getObject()`, `setPageBox()`).

## Q2 — Throughput (large-300p, 612×792, ~41 lines/page)

| scale | first page | 300 pages | pages/sec |
|---|---|---|---|
| 1.0× | 12ms | 0.4s | 827.9 pg/s |
| 2.0× | 3ms | 0.4s | 687.4 pg/s |

Caveat: "first page" timings are noisy at this scale (sub-20ms, single-digit-ms resolution, JIT/cache warm from the prior loop) — treat them as "render is fast, sub-frame-budget" rather than precise numbers. Steady-state throughput (600+ pages/sec) is well above what any interactive UI needs; document-open time was not isolated from the timing loop (loading `large-300p.pdf`, 651KB/300 pages, happens once before either loop starts).

## Q3 — Memory

Peak RSS observed: 210MB (with disposal, across both 300-page loops = 600 total page renders).

With `destroy()`: rssDelta = **7MB** (scale 1) / **5MB** (scale 2). RSS was flat across the whole run (200MB → 204MB → 204MB, sampled every 100 pages).

Without `destroy()`: rssDelta = **433MB** after just the *first* 300-page loop (scale 1) alone, then continued climbing through the scale 2 loop (620MB → 744MB → 1058MB by page 200) until the process **fatally crashed**: `Error: malloc (5816448 bytes) failed` (WASM linear-memory OOM) partway through the scale-2 loop — it never finished all 600 renders.

**Disposal required: YES — and it is not optional, it is load-bearing.** Omitting `pixmap.destroy()`/`page.destroy()` doesn't just "leak slowly," it OOM-crashes the WASM heap within a single 300–600 page sweep, well inside a normal editing session on a 300-page document. `render.ts` (Task 9) must wrap every `toPixmap()`/`loadPage()` call in `try/finally` and call `.destroy()` unconditionally.

API note: `destroy()` is *inherited* from a shared `Userdata` base class up the prototype chain (`PDFPage → Page → Userdata`, `Pixmap → Userdata`, etc.) — it does not show up in `Object.getOwnPropertyNames(Object.getPrototypeOf(obj))` (the brief's `surface()` helper only walks one level), which made it look absent at first. It is real and callable: `'destroy' in pix` is `true` and `typeof pix.destroy === 'function'`.

## Q4 — Structured text shape

Working option string: any string works, including `''`. `page.toStructuredText(options?: string)` accepts a free-form comma-separated options string (e.g. `'preserve-whitespace'`, `'preserve-spans'`) that affects internal text *segmentation*, not the JSON schema. **Critical API drift from the brief**: `StructuredText.asJSON()`'s real signature is `asJSON(scale?: number)` — it does not take an options string at all (the options only apply to `toStructuredText()`). All three option strings produced byte-identical JSON on our fixtures.

Actual JSON shape (from `packages/pdf-core` fixtures `simple-text` and `mixed-fonts`):

```
{ blocks: [ { type, bbox, lines: [ { wmode, bbox, font: {name, family, weight, style, size}, x, y, text } ] } ] }
```

**There is no `spans` array nested under `lines`.** Each `lines[]` entry is already a homogeneous-style run — in `mixed-fonts` page 0, six separate text objects (Helvetica, Helvetica-Bold, Helvetica-Oblique, Times-Roman, Times-Italic, Courier) each produced their own `block.lines[0]` entry with correct per-run `font.name/weight/style/size`, `text` as a plain string. No fixture exercised *multiple* fonts within one single visual line, so it's inferred (not proven) that a mixed-run visual line would produce multiple `lines[]`-shaped entries rather than one entry with a nested run list — but there is no `spans` key anywhere in the schema, so if it happens, it's exposed exactly the same way a full JSON "line" is: `font` at that same object's top level.

Per-span font name: **YES** (`font.name`, e.g. `"Helvetica-Bold"`, `"Times-Italic"`)
size: **YES** (`font.size`)
weight: **YES** (`font.weight`: `"normal"|"bold"`)
italic: **YES** (`font.style`: `"normal"|"italic"`)
Per-character bboxes: **NO** — not present anywhere in `asJSON()` output at any option setting.

Real span object (from `spikes/out-st-mixed-fonts-0.json`):
```json
{
  "wmode": 0,
  "bbox": { "x": 72, "y": 87, "w": 205, "h": 19, "flags": 0 },
  "font": { "name": "Helvetica-Bold", "family": "sans-serif", "weight": "bold", "style": "normal", "size": 14 },
  "x": 72, "y": 102,
  "text": "Helvetica-Bold sample text 123"
}
```

**However — per-character data does exist, via a different API entirely**: `StructuredText.walk({ onChar(c, origin, font, size, quad, color, bidi) {...} })`. Verified on `mixed-fonts` page 0 (166 characters walked): each call gives the character string, its origin point, a real `Font` object (with `.getName()`, `.isBold()`, `.isItalic()`, `.isSerif()`, `.isMono()`), size, a `quad` (an 8-number quadrilateral `[x0,y0,x1,y1,x2,y2,x3,y3]`, not an axis-aligned rect — needed for rotated/skewed glyph runs), fill color, and bidi level. Sample record:
```json
{ "c": "H", "origin": [72,72], "fontName": "Helvetica", "size": 14,
  "quad": [72,56.95,82.108,56.95,72,76.186,82.108,76.186], "color": [0,0,0], "bidi": 0 }
```

IMPACT ON SPEC §2.4: Font metadata is present, so span-level (and even character-level) text patching is achievable — this is good news, not a blocker. But **the brief's assumed code path is wrong**: there is no `line.spans[]` array and no per-character bboxes in `asJSON()`. Task 10 (`text.ts`) needs two different calls depending on granularity: `toStructuredText().asJSON()` for span/line-level text+font (sufficient for whole-run replace or font-swap operations), and `StructuredText.walk({onChar})` for character-level quads (needed for precise markup-quad computation per spec §2.1, or sub-span edits). Planning a single `asJSON()`-only implementation, as the brief's probe code implies, would silently omit character-level positioning — this needs to be corrected before Task 10 starts, not discovered mid-implementation.

## Q5 — getBounds()

Returns: **CropBox** (confirmed: `page.getBounds()` === `page.getBounds('CropBox')`, both `[0,0,400,500]`; `page.getBounds('MediaBox')` differs: `[-50,-212,562,580]`).

Includes non-zero origin: **NO — this is the single most important finding of the spike, and the brief's own "expected" comment was wrong about it.**

Ground truth read directly off the PDF object dict (`page.getObject().get('CropBox')`): the raw `/CropBox` array on disk is `[50 80 450 580]` (pdf-lib's `setCropBox(x, y, w, h)` call with `(50, 80, 400, 500)` writes the raw PDF rect `[x0, y0, x0+w, y0+h] = [50, 80, 450, 580]`, *not* `[50,80,400,500]` as the brief's comment assumed — that quadruple is width/height-form, not the stored PDF rect form). Raw `/MediaBox` is `[0 0 612 792]`, as expected.

But `page.getBounds()` returns `[0, 0, 400, 500]` — origin normalized to `(0,0)`, not the raw `(50,80)`. And `getBounds('MediaBox')` returns `[-50, -212, 562, 580]` (width/height correctly preserved as 612×792, but translated/flipped relative to the *same* normalized frame). Reconstructing the transform: `newX = rawX − CropBox.x0` and `newY = CropBox.y1 − rawY` (i.e. a translation by the crop origin **plus** a Y-flip anchored at the crop box's top edge). This was confirmed directly and independently by reading `page.getTransform()` (see Q6) and by rendering: `page.toPixmap(Matrix.identity, ...)` on `offset-cropbox` page 0 produces a **400×500** pixmap — matching the CropBox-normalized frame, not the raw 612×792 MediaBox.

In short: mupdf's `getBounds()`/`toPixmap()`/`getTransform()` all operate in one shared "page space" that already has the CropBox origin zeroed out and the Y-axis flipped top-down — this is *not* raw PDF content-stream space (which annotation `/Rect`/`QuadPoints` live in, and which is bottom-up with no CropBox correction).

## Q6 — Rotation

`/Rotate` is exposed as a **plain integer PDF page-dictionary entry** — `page.getObject().get('Rotate')` returned `0`, `90`, `180`, `270` for the four `rotated.pdf` pages, exactly as expected from the fixture spec.

`toPixmap` applies `/Rotate` automatically: **YES.**

Evidence, two independent lines, in full agreement:

1. **Printed dimensions swap.** `page.getBounds()` and the rendered pixmap dimensions both swap width/height for the 90°- and 270°-rotated pages: page 0 → bounds `[0,0,612,792]`, pixmap `612×792`; page 1 (rotate 90) → bounds `[0,0,792,612]`, pixmap `792×612`; page 2 (rotate 180) → bounds `[0,0,612,792]`, pixmap `612×792`; page 3 (rotate 270) → bounds `[0,0,792,612]`, pixmap `792×612`.
2. **Visual inspection** (`spikes/out-rot-0.png` .. `out-rot-3.png`, read directly): page 0 shows "rotate 0" upright top-left and the red origin marker at bottom-left (matches PDF-space `(0,0)` with only a y-flip). Page 1 shows the text rotated 90° (reading bottom-to-top along the right edge) and the red marker now at top-left, on a landscape canvas. Page 2 shows the text fully upside-down, bottom-right, red marker top-right. Page 3 shows the text rotated the other way, red marker bottom-right, landscape canvas again. All four are genuinely rotated content, not just resized canvases.

A third, stronger piece of evidence beyond what the brief asked for: `page.getTransform(): Matrix` returns mupdf's literal composed "PDF user space → page space" matrix, and it already contains the rotation, not just a y-flip:
- page 0 (rotate 0): `[1, 0, 0, -1, 0, 792]` — pure y-flip by page height.
- page 1 (rotate 90): `[0, 1, 1, 0, 0, 0]` — a combined rotate+flip matrix, not `[1,0,0,-1,...]`.
- page 2 (rotate 180): `[-1, -0, 0, 1, 612, 0]`.
- page 3 (rotate 270): `[0, -1, -1, -0, 792, 612]`.

All lines of evidence agree — there is no disagreement to report here.

IMPACT ON TASK 7: the transform module must **not** re-apply rotation, and it must not assume raw PDF-space equals render-space with only a bare y-flip. `toPixmap`'s output space already has three things baked in together: CropBox-origin translation (Q5), a top-down y-flip, and `/Rotate`. Anything computed in *raw* PDF content-stream space (annotation `/Rect`, `QuadPoints`, etc., which are untransformed) must be passed through `page.getTransform()` (or an equivalent replica) composed with the caller's scale matrix before it will land correctly on the rendered pixmap — a plain y-flip is insufficient on both the `offset-cropbox` and `rotated` fixtures. The spec's stated Layer-2 root `<g transform>` covering "only the y-flip" needs to be re-scoped to cover the fuller composed transform for these two fixture cases.

## Decisions

- Task 9 (`render.ts`): every `loadPage()`/`toPixmap()` call must be wrapped in `try/finally` calling `.destroy()` on the page and pixmap — Q3 showed omitting this OOM-crashes within one page-scale sweep of a 300-page doc.
- Task 9: do not add a separate rotation step — `toPixmap` already applies `/Rotate` (Q6). Applying it again in application code would double-rotate.
- Task 7 (coordinate transform): must compose `page.getTransform()` (CropBox-origin translate + y-flip + rotate, all combined) rather than a bare y-flip, whenever mapping raw PDF-space geometry (annotations, quads) onto rendered pixels — verified necessary on both `offset-cropbox` and `rotated` fixtures (Q5, Q6).
- Task 7/9: use `page.getBounds()` (CropBox, origin-normalized) as the canvas size for rendering/layout — it is not the raw stored CropBox rect, and callers must not re-subtract a crop origin that's already gone.
- Task 10 (`text.ts`): use `toStructuredText().asJSON()` for span/line-level text + font metadata (name/size/weight/italic all present, Q4), and `StructuredText.walk({onChar})` separately for character-level quads/positions — no single call gives both. Plan the two-call approach explicitly rather than assuming one `asJSON()` shape covers everything.
- Task 9/10: `toStructuredText(optionsString)` accepts an options string; `asJSON()` itself only takes a numeric `scale` argument — don't design an API around option-driven JSON shape changes, they don't exist at this level.
- General: mupdf resolved to 1.28.0, not the planned `^1.26.0` — treat the shipped `.d.ts` (`packages/pdf-core/node_modules/mupdf/dist/mupdf.d.ts`) as the source of truth for future tasks, not assumptions carried over from the plan.
- General: `destroy()`/other lifecycle methods are inherited from a shared `Userdata` base class and won't show up in naive `Object.getOwnPropertyNames(Object.getPrototypeOf(obj))` introspection — future probes should walk the full prototype chain (see `spikes/00-probe-disposal.ts`) before concluding a method is missing.
