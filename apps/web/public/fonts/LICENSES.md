# Bundled fonts

All five are licensed under the **SIL Open Font License, Version 1.1**, whose
full text is in [`OFL.txt`](./OFL.txt) beside this file. The OFL requires the
licence to travel with the font, which is why it is vendored here rather than
linked.

| File | Family | Weight | Copyright | Upstream |
|---|---|---|---|---|
| `Inter.ttf` | Inter | 400 | Copyright 2020 The Inter Project Authors | https://github.com/rsms/inter |
| `Inter-Bold.ttf` | Inter | 700 | Copyright 2020 The Inter Project Authors | https://github.com/rsms/inter |
| `Roboto.ttf` | Roboto | 400 | Copyright 2011 The Roboto Project Authors | https://github.com/googlefonts/roboto-classic |
| `Roboto-Bold.ttf` | Roboto | 700 | Copyright 2011 The Roboto Project Authors | https://github.com/googlefonts/roboto-classic |
| `SourceSerif4.ttf` | Source Serif 4 | 400 | Copyright 2014 The Source Serif 4 Project Authors | https://github.com/adobe-fonts/source-serif |
| `SourceSerif4-Bold.ttf` | Source Serif 4 | 700 | Copyright 2014 The Source Serif 4 Project Authors | https://github.com/adobe-fonts/source-serif |
| `Merriweather.ttf` | Merriweather | 400 | Copyright 2020 The Merriweather Project Authors, with Reserved Font Name "Merriweather" | https://github.com/EbenSorkin/Merriweather4 |
| `Merriweather-Bold.ttf` | Merriweather | 700 | Copyright 2020 The Merriweather Project Authors, with Reserved Font Name "Merriweather" | https://github.com/EbenSorkin/Merriweather4 |
| `JetBrainsMono.ttf` | JetBrains Mono | 400 | Copyright 2020 The JetBrains Mono Project Authors | https://github.com/JetBrains/JetBrainsMono |
| `JetBrainsMono-Bold.ttf` | JetBrains Mono | 700 | Copyright 2020 The JetBrains Mono Project Authors | https://github.com/JetBrains/JetBrainsMono |

### Why a real bold file and not a synthesised one

A viewer asked for bold with only a regular face loaded draws *faux* bold —
it strokes the regular outlines. That is cheap and it is wrong here for a
reason that is not aesthetic: faux bold keeps the **regular's advance
widths**, so a centred or right-aligned line would be positioned by the
writer's `measure()` against metrics that do not describe the ink on the
page. The preview would agree with the export and both would be visibly
off-centre. A real weight-700 instance costs one more file per family
(~33–130 KB, fetched only when a document actually uses it) and makes the
measurement true.

Fetched at `:700` from the **v1** CSS endpoint. `:wght@700` is css2 syntax
and the v1 endpoint ignores it and serves weight 400 instead — silently,
because what comes back is still a perfectly valid TrueType. `fonts.test.ts`
asserts each bold measures wider than its regular so that mistake cannot be
committed twice.

### Signature script faces (browser-only)

These three are offered by the typed-signature tab and are **never embedded in a PDF**: a typed
signature is rasterised to a transparent PNG and placed as an image, so the face is needed only to
draw that raster. They are deliberately absent from the text tool's font picker — a signature
script is not body copy — and `fontsForExport` filters them out so one can never reach the writer.

| File | Family | Copyright | Upstream |
|---|---|---|---|
| `Caveat.ttf` | Caveat | Copyright 2014 The Caveat Project Authors | https://github.com/googlefonts/caveat |
| `DancingScript.ttf` | Dancing Script | Copyright 2016 The Dancing Script Project Authors, with Reserved Font Name 'Dancing Script' | https://github.com/googlefonts/DancingScript |
| `GreatVibes.ttf` | Great Vibes | Copyright 2015 The Great Vibes Pro Project Authors | https://github.com/googlefonts/great-vibes |

## Why these files, self-hosted

Spec §2.5: the preview and the export must use **byte-identical** font files,
and opening a document must make no third-party request. Both rule out a CDN.
The browser loads these via `FontFace` for on-screen measurement; the worker
embeds these same bytes into the exported PDF. One file, two consumers.

## Why static instances, not the variable fonts

`google/fonts` now publishes only variable TTFs for these families. They work
— MuPDF loads them and renders the default instance correctly — but
`addSimpleFont` embeds the **entire** font program with no subsetting (Phase 0
measured 57–65% of raw size, and `subsetFonts()` makes no difference for a
freshly registered font). Variable Merriweather is 4.6 MB, so a document with
one line of text in it would carry roughly 3 MB of font.

These files are therefore the static weight-400 and weight-700 instances
Google Fonts serves to legacy user agents, refetchable with
`pnpm --filter @margin/web fonts:fetch`
(see `apps/web/scripts/fetch-fonts.mjs`, which records the exact request).
Combined they are ~680 KB across both weights, and a typical document embeds
one or two of them.

Subsetting — which would cut even that to a few KB — needs `pdf-lib` +
`@pdf-lib/fontkit` and is deliberately deferred to Phase 4
(`PHASE-2-DESIGN.md` §0). It is a size optimisation, not a capability.

## Scope

Registered with `addSimpleFont(font, 'Latin')`. Non-Latin scripts are out of
scope for Phase 2 — a stated limitation, not an oversight.
