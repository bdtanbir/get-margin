# Settled MuPDF.js facts — read before implementing Tasks 8, 9, 10

These are **measured, verified results**, not assumptions. They come from the Task 3 spike
(`docs/findings/01-read-path.md`) and were independently cross-checked by the controller.
Where they contradict your task brief, **these win** — the brief was written before the
spike ran, against a different mupdf version.

Treat `packages/pdf-core/node_modules/mupdf/dist/mupdf.d.ts` as the API source of truth.

---

## Version

`mupdf` resolved to **1.28.0**, not the `^1.26.0` the plan was written against. Expect drift
from any API shape the brief asserts.

## Verified call sequence

```ts
import * as mupdf from 'mupdf'

const doc = mupdf.Document.openDocument(bytes, 'application/pdf')  // -> PDFDocument for PDF input
const page = doc.loadPage(0)                                        // -> PDFPage
const pix  = page.toPixmap(matrix, colorspace, alpha?, showExtras?) // -> Pixmap
const px   = pix.getPixels()                                        // -> Uint8ClampedArray
const stride = pix.getStride()                                      // bytes per row
const png  = pix.asPNG()                                            // -> Uint8Array
```

`loadPage()`/`openDocument()` return the **PDF-specific subclasses** (`PDFPage`, `PDFDocument`),
which carry methods the generic `Page`/`Document` bases lack: `getTransform()`, `getObject()`,
`setPageBox()`. `PDFPage.toPixmap` has the wider signature
`(matrix, colorspace, alpha?, showExtras?, usage?: string, box?: PageBox)`.

## Pixel layout — matters for Task 9

With `alpha = false`: **3 bytes/px RGB, no alpha.** Measured: 612×792 page at scale 2 →
1224×1584 pixmap, 5,816,448 bytes total, stride 3672 = 1224 × 3 exactly (**no row padding
observed**).

**`alpha = true` — measured during Task 9, and it has a trap.** It yields 4-byte RGBA, contiguous,
stride = width × 4 with no padding. **But the content is premultiplied alpha over a TRANSPARENT
background, not opaque white.** A PDF page is conceptually white-backed; MuPDF does not paint that
white for you when alpha is requested.

Consequence: handing those bytes straight to `ImageData` gives a page with a transparent
background, which composites against whatever is behind the canvas — typically reading as black or
as the app's workspace colour, not as paper. `render.ts` therefore composites onto opaque white and
forces output alpha to 255.

Because the source is **premultiplied**, the correct composite over white is
`out = src + (1 − alpha) × 255` per channel — *not* the straight-alpha form
`out = src × alpha + (1 − alpha) × 255`, which would double-apply the alpha and produce washed-out
output on any partially transparent pixel (anti-aliased glyph edges, most visibly). Whichever form
is used, it must match the premultiplied source.

`ImageData` requires 4 channels either way, so keep a length-based dispatch handling both 3- and
4-byte layouts.

**Guard the stride.** Assert `getStride() === width × bytesPerPixel` and throw a clear error
otherwise. A padded pixmap copied as if contiguous produces a progressively sheared image —
corruption that looks like a rendering artifact and is miserable to trace.

## Disposal is MANDATORY — not a nicety

`destroy()` is inherited from a shared `Userdata` base class. It does **not** appear in
one-level `Object.getOwnPropertyNames(Object.getPrototypeOf(obj))` introspection, but it is
real: `'destroy' in pix === true`.

Measured over 300-page sweeps:

| | rssDelta |
|---|---|
| with `destroy()` | **7MB** (scale 1) / **5MB** (scale 2) — flat across the run |
| without `destroy()` | **+433MB** after the first 300-page loop, climbing to 1058MB, then a **fatal crash**: `Error: malloc (5816448 bytes) failed` |

Omitting disposal does not leak slowly — it **hard-crashes the WASM heap** inside a single
300–600 page sweep, well within a normal editing session. Every `loadPage()` and `toPixmap()`
must be wrapped in `try/finally` calling `.destroy()` unconditionally.

## Page space: three transforms are already baked in

This is the subtlest and most consequential finding.

`getBounds()`, `toPixmap()`, and `getTransform()` all operate in one shared "page space" that
already has **(a)** the CropBox origin translated to (0,0), **(b)** a top-down y-flip, and
**(c)** the page's `/Rotate` applied.

This is **not** the raw PDF content-stream space that the on-disk dictionary stores, which is
bottom-up with no CropBox correction.

> ## ✅ VERIFIED — evidence committed
>
> This claim was initially narrated with no committed probe, was flagged provisional, and has since
> been **re-derived and reproduced exactly** with committed evidence (`spikes/05`–`09`). Safe to
> build on.
>
> **CORRECTION (measured by the Task 4 write-path spike — read this before touching annotations).**
> An earlier version of this file said "`/Rect` and `/QuadPoints` live in bottom-up space, not page
> space." That is true of the **raw on-disk dictionary value** and **false of what the
> `PDFAnnotation` methods expose**. `setRect()`, `getRect()`, `setQuadPoints()` and `setLine()` all
> operate in **page space (top-down)** — the same convention `toPixmap`, `getBounds()`,
> `getTransform()` and `asJSON()` use. The binding flips y transparently on every get/set.
>
> Measured directly:
> ```
> setRect([72, 400, 200, 460])
> getRect()                        -> [72, 400, 200, 460]   // page-space, round-trips exactly
> getObject().get('Rect').asJS()   -> [71, 331, 201, 393]   // raw on-disk dict, bottom-up
> ```
> (`792 − 400 = 392`, `792 − 460 = 332`, matching the raw y-range within ~1pt of border inflation.)
> Cross-confirmed independently by sampling the rendered PNG for three pure-colour annotations:
> `img_row = raw_y × scale` matched within 1–3px; the naive `(pageHeight − raw_y) × scale` flip was
> off by 120–140px and is ruled out.
>
> **Consequence:** feed these setters page-space coordinates directly — the same ones `transform`
> and `render.ts` already produce — with **no manual bottom-up flip**. Applying the read-path flip
> rule here places every annotation 120–140px off. The spike made exactly that mistake on its first
> pass and caught it only with pixel evidence.

- `page.getBounds()` returns the **CropBox**, origin-normalized to (0,0). Confirmed:
  `getBounds() === getBounds('CropBox')`. For the `offset-cropbox` fixture (raw `/CropBox`
  `[50 80 400 500]`), `getBounds()` returns `[0, 0, 350, 420]` — the origin is already gone.
  **Callers must not subtract a crop origin that has already been removed.**
- Raw dictionary values are still readable via `page.getObject().get('CropBox')` /
  `.get('MediaBox')` / `.get('Rotate')`. `/Rotate` is a plain integer.
- Derived rule: `newX = rawX − cropBox.x0`, `newY = cropBox.y1 − rawY`.

### `/Rotate` is applied by `toPixmap` automatically — confirmed three ways

1. Pixmap dimensions swap for 90°/270°: rotate 0 → 612×792; 90 → 792×612; 180 → 612×792;
   270 → 792×612.
2. Visual inspection of four rendered PNGs: content is genuinely rotated, not merely placed on
   a resized canvas. (Independently reproduced by the reviewer.)
3. `page.getTransform()` returns a composed matrix that already contains the rotation.

`getTransform()` values for a 612×792 page, CropBox origin (0,0), in `[a,b,c,d,e,f]` form
where `x' = a·x + c·y + e` and `y' = b·x + d·y + f`:

| /Rotate | matrix | means |
|---|---|---|
| 0 | `[1, 0, 0, -1, 0, 792]` | x' = x, y' = 792 − y |
| 90 | `[0, 1, 1, 0, 0, 0]` | x' = y, y' = x |
| 180 | `[-1, 0, 0, 1, 612, 0]` | x' = 612 − x, y' = y |
| 270 | `[0, -1, -1, 0, 792, 612]` | x' = 792 − y, y' = 612 − x |

**The controller verified all four against `@margin/transform`'s specified `pdfToView` math —
they match exactly, including the CropBox term.** So:

- **Task 7 (`transform`)**: correctly applies cropbox-translate + y-flip + rotate. It maps raw
  PDF space → rendered pixels, so it *must* include rotation.
- **Task 9 (`render.ts`)**: must **not** compose an extra rotation into the matrix passed to
  `toPixmap`. Doing so double-rotates. Pass scale only.

Both statements are true at once. "MuPDF applies rotation" constrains `render.ts`, not
`transform`.

## Annotations — settled by the Task 4 write-path spike

Full detail in `docs/findings/02-write-path.md`. What binds later tasks:

- **`createAnnotation(type)` works for all 10 types tested** (Highlight, Underline, StrikeOut, Ink,
  FreeText, Square, Circle, Line, Link, Stamp). After the appropriate setters plus `update()`,
  MuPDF **auto-generates a real `/AP` appearance stream** for all of them except Link — verified
  programmatically (`getObject().get('AP').isDictionary()`), not just by looking at a render.
- **No cross-renderer disagreement.** The saved PDF was rasterised by MuPDF and independently by
  Apple's CoreGraphics engine (`qlmanage -t`, the engine Preview uses); the two are
  indistinguishable in layout, colour and content for every working type. Acrobat and Chrome are
  **NOT VERIFIED — they need a human check**, and must not be claimed as passing.
- **Link is a different API entirely.** `createAnnotation('Link')` succeeds but the resulting
  annotation **rejects `setRect()`** (`hasRect()` is false — "Link annotations have no Rect
  property"). Use **`page.createLink(bbox, uri)`** instead: a separate `fz_link` class, not
  `pdf_annot`. It round-trips `getURI()` exactly. `fz_link` has no `/AP` concept — link hotspots
  are invisible by design, per the PDF spec.
- **Low-level `PDFObject.put()` on a Link's `Rect` is safe, contrary to an earlier claim here.**
  An initial version of this file said it hard-aborts the WASM runtime. That did **not** reproduce
  under isolation: the `put()` succeeds without crashing. The apparent crash was an *unwrapped*
  `getRect()` call one line earlier throwing an ordinary, catchable
  `Error: Link annotations have no Rect property`, which Node's default handler printed as a wall
  of minified source and which was mistaken for a WASM abort. **Ordinary `try/catch` is sufficient
  around these calls; no special crash-containment is needed.** The Task 3 disposal finding remains
  the one genuine hard-WASM-crash case.
- **`Stamp` annotations render a default "DRAFT" icon** supplied by MuPDF when no icon or contents
  is set — not an empty annotation.

### Fonts, and why `pdf-lib` is now a runtime dependency

- `new mupdf.Font(name, bytes)`, `doc.addSimpleFont(font, encoding)` and `doc.addFont(font)` all
  work on arbitrary TTFs. Drawing and **measurement** are sound: `showString()`'s advance and an
  independent sum of `advanceGlyph(encodeCharacter(ch))` agreed to 5 decimal places.
- **There is no automatic subsetting.** Registering a font costs **57–65% of its raw byte size
  immediately**, measured at two very different scales (22.2MB Arial Unicode → ~14.9MB;
  755KB Arial → ~431KB). That is plain Flate compression of the whole font program.
- `doc.subsetFonts()` exists but made **zero measurable difference** in three separate
  configurations — plausibly because it only prunes glyphs referenced by real content-stream
  operators, which a freshly registered font has none of. Unverified for the drawn-content case.
- **DECISION: `pdf-lib` (+ `@pdf-lib/fontkit`) becomes a runtime dependency, scoped strictly to
  font subsetting/embedding.** MuPDF remains the single engine for rendering, annotations, page
  composition and save. PLAN.md §8 to be updated at Task 11.
- **`FreeText` covers the standard 14 base fonts only.** Size, colour and family work via
  `setDefaultAppearance`; `setQuadding(0|1|2)` is accepted. But a custom registered font is
  silently ignored — no `/DR` dictionary is created to resolve the name, and MuPDF's own
  `getDefaultAppearance()` reads back `Helv`. Custom-font text needs content-stream operators or a
  hand-built `/DR`.

### Unexercised capabilities worth knowing exist

`PDFDocument` also exposes a built-in undo/redo **journal**
(`enableJournal`/`beginOperation`/`endOperation`/`undo`/`redo`/`canUndo`/`canRedo`), page
management (`addPage`/`insertPage`/`deletePage`/`rearrangePages`), OCG layers, and
`addEmbeddedFile`. None were exercised. Flagged so a later task doesn't reach for a third-party
library out of habit — though note the app's own undo model is client-side Immer patches over a
serializable edit log, which is a deliberate architectural choice and not superseded by this.

## `PDFObject` API drift — measured while implementing Task 8

The plan's structural `RawObj` type assumed an optional-method surface. The real `PDFObject` in
mupdf 1.28.0 differs in three ways that matter:

- **`get()` never returns `undefined`.** A missing key yields a `PDFObject` whose `isNull()` is
  `true`. So `if (!obj.get('CropBox'))` is always false and will not detect an absent key — test
  `isNull()` instead. This is the drift most likely to cause a silent bug.
- **`isArray()` / `isNumber()` / `isNull()` are always present**, not optional. No `?.` guards
  needed.
- **There is no `asFloat()`** — only `asNumber()`.
- `destroy()` and `getObject()` are real typed methods on the shipped `.d.ts`, so no defensive
  casts are needed for either.

## Structured text — `asJSON()` shape (forward-looking; no Phase 0/1 task builds `text.ts`)

`page.toStructuredText(options?: string)` takes a free-form options string affecting internal
segmentation. **`StructuredText.asJSON()` takes only `(scale?: number)` — no options string.**
All option strings produced byte-identical JSON on the fixtures.

Real shape:

```
{ blocks: [ { type, bbox, lines: [ { wmode, bbox, font: {name, family, weight, style, size}, x, y, text } ] } ] }
```

- **There is no `spans` array under `lines`.** Each `lines[]` entry is already a
  homogeneous-style run.
- Per-run font name / size / weight / style: **all present** (`"Helvetica-Bold"`, `14`,
  `"bold"`, `"italic"`). Span-level text editing is therefore viable.
- **Per-character bboxes: absent** from `asJSON()` at every option setting.
- Character-level data comes from a different API: `StructuredText.walk({ onChar(...) })`,
  which yields the character, origin, a `Font` object, size, an **8-number quad**
  `[x0,y0,x1,y1,x2,y2,x3,y3]` (not an axis-aligned rect — needed for rotated/skewed runs),
  fill color, and bidi level.

Consequence for Phase 2: `text.ts` needs **two calls** — `asJSON()` for span/line text+font,
`walk({onChar})` for character quads. No single call gives both.

## Throughput (context, not a constraint)

`large-300p` (612×792, ~41 text lines/page), M1 Pro: ~828 pg/s at 1.0×, ~687 pg/s at 2.0×.
Document-open is excluded from the timed region. Far above what an interactive UI needs.

## Probing advice, learned the hard way

Lifecycle methods live on inherited base classes. Walk the **full prototype chain** before
concluding a method is missing — a one-level `getOwnPropertyNames(getPrototypeOf(x))` check
wrongly reported `destroy()` as absent.
