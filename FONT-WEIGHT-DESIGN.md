# Font weight 100–800

Text the user places, and document text they retype, can be set in any weight
from 100 (Thin) to 800 (Extra Bold), not just regular and bold. The inspector
offers the weight as a select, and editing a line the document already contains
starts at the weight that line is actually set in.

## What changes, and why in this shape

### 1. The format: `bold?: boolean` becomes `weight?: number`

`TextObject` and `TextPatchObject` lose `bold` and gain `weight`, one of
100, 200, 300, 400, 500, 600, 700, 800. Absent means 400.

A migration step (v3 → v4) rewrites every stored `bold: true` into
`weight: 700` and drops the key. A dual read (`weight ?? (bold ? 700 : 400)`)
would have avoided the migration, but it leaves a boolean in the type forever
that means one specific value of the number beside it, and every consumer has
to remember the fallback. One migration, one field.

`FaceStyle` in pdf-core becomes `{ weight?: number; italic?: boolean }`.
`faceKey` spells a face as `Inter 500 Italic`; weight 400 is left off, so the
regular keeps its bare family name as the key and nothing that only ever used
the regular changes.

### 2. The files: one static instance per weight per slope, and the Google Docs families

Google Fonts' legacy endpoint serves a real static instance for each weight,
and they are what get fetched, under a uniform name:
`<Base>-<weight>.ttf` and `<Base>-<weight>Italic.ttf`. The four existing
files per family are renamed into that scheme rather than kept beside it.

The set grows to the families Google Docs' font menu offers. The ones Google
Fonts serves are taken as they are: Amatic SC, Caveat, Comfortaa, EB
Garamond, Lexend, Lobster, Lora, Merriweather, Montserrat, Nunito, Oswald,
Pacifico, Playfair Display, Roboto, Roboto Mono, Roboto Serif, Spectral. The
proprietary Microsoft faces in that menu cannot be served, so their open
metric-compatible equivalents stand in and the picker shows both names:
Arimo (Arial), Tinos (Times New Roman), Cousine (Courier New), Gelasio
(Georgia), Comic Neue (Comic Sans MS), Anton (Impact). Verdana and Trebuchet
MS have no open equivalent and are left out. Inter, Source Serif 4 and
JetBrains Mono stay.

Not every family reaches every weight, and several have no italic at all.
The catalogue records each family's real coverage, in one JSON file
(`apps/web/src/lib/fontCatalog.json`) that both the fetch script and the app
read, so what is offered is exactly what was fetched. The picker lists only
the weights the chosen family has, hides Italic for a family without one,
and a family change snaps the weight and slope to the nearest face the new
family has, in the same undo step.

That is 236 files, 12 MB in the repo. Still fetched on demand, so a document
pays only for the faces it uses. The test that reads each file's own OS/2
table asserts every file's `usWeightClass` matches the weight in its name
(Inter's two lightest declare 250, so those are held to "under 300"), that
every catalogued file exists, and that every file on disk is catalogued.

Why not variable fonts: unchanged from LICENSES.md. `addSimpleFont` embeds the
whole program, so a variable Merriweather would put 4.6 MB into a document
that used one line of it.

### 3. Detection: the weight a line is already set in

`LineRun.bold` becomes `LineRun.weight: number`. Three sources, best first:

1. **The name.** The style word after the last `-` or `,` in the face's
   name: `Thin`, `ExtraLight`/`UltraLight`, `Light`, `Regular`, `Medium`,
   `SemiBold`/`DemiBold`, `Bold`, `ExtraBold`/`UltraBold`, `Black`/`Heavy`
   map to their conventional weights; the old `BOLD_IN_NAME` heuristic folds
   into this table. The name comes first because the OS/2 table lies in one
   known way: Inter's Thin and ExtraLight both declare 250.
2. **The embedded font program.** The page's `/Resources /Font` dictionary is
   walked once per page. For each font, the descriptor's `/FontFile2` (or an
   OpenType `/FontFile3`) is parsed for its OS/2 `usWeightClass`; failing
   that, the descriptor's `/FontWeight`. Keyed by `BaseFont` with any subset
   prefix stripped, which is the same name MuPDF's `Font.getName()` reports
   (verified: a file embedded as `Inter-Bold` comes back as `Inter-Bold`).
3. **`isBold()`**: 700, otherwise 400.

The result is clamped to 100–800, so a Black face (900) edits as Extra Bold
rather than as a weight nothing has a file for.

The round-trip test is the one that matters: write a text object at 500,
re-open the output, and the extracted line reports 500.

### 4. The inspector: a select, per family

`inspectorFields` replaces the Bold checkbox with a Weight select whose options
are the weights the object's family actually has. Labels are
`100 Thin` … `800 Extra Bold`. The select field type grows a `numeric` flag so
the Inspector writes a number rather than the string the DOM hands back.

Changing the family to one that lacks the current weight snaps the weight to
the nearest one the new family has, in the same undo step as the family
change. A patch created from a detected weight goes through the same snap for
the family it is built in.

### 5. Everything that read `bold`

- `SelectionToolbar`'s Bold button stays a toggle: pressed when every touched
  line is at 600 or above; pressing it sets 700, or 400 to clear.
- `PatchEditor`'s Ctrl+B does the same on the line being edited.
- `linePatch`, `buildReplacements`, `editTargets`, `useDrawTool`, and the three
  overlay components pass `weight` where they passed `bold`.
- `cssWeight(weight)` returns the number as a string; the FontFace descriptor,
  the canvas measurement string, and the rendered markup all use it.

## Files

pdf-core: `write/types.ts`, `write/migrate.ts`, `write/fonts.ts`,
`text/index.ts`, `text/find.ts`, plus a new `text/fontWeights.ts` for the
resource walk and OS/2 read.

web: `lib/fonts.ts`, `lib/fontCatalog.json`, `scripts/fetch-fonts.mjs`, `public/fonts/*`,
`public/fonts/LICENSES.md`, `features/tools/inspectorFields.ts`,
`features/tools/Inspector.vue`, `features/tools/SelectionToolbar.vue`,
`features/patch/linePatch.ts`, `features/patch/PatchEditor.vue`,
`features/patch/editTargets.ts`, `features/find/buildReplacements.ts`,
`features/overlay/useDrawTool.ts`, `features/overlay/TextEditor.vue`,
`features/overlay/objects/TextObject.vue`,
`features/overlay/objects/TextPatchObject.vue`, and their tests.

## Order of work

1. Fonts: fetch script, files, LICENSES.md, file test.
2. pdf-core: FaceStyle/faceKey, types + migration, detection, tests.
3. web lib: fonts.ts.
4. web features: inspector, toolbar, patch editor, overlay, defaults, tests.

Each step is committed on its own once its tests pass.

## A bug found on the way

`Buffer.asUint8Array()` in mupdf.js is a view over the WASM heap, not a copy.
`replay` returned it directly, and the next thing to grow the heap, which the
per-page font-program read now does, detached the view and left the caller
holding a zero-length "PDF". The exported bytes are now copied out of the
heap in `replay`, `recompressImages` and `protect`.
