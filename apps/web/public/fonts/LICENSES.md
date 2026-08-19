# Bundled fonts

All five are licensed under the **SIL Open Font License, Version 1.1**, whose
full text is in [`OFL.txt`](./OFL.txt) beside this file. The OFL requires the
licence to travel with the font, which is why it is vendored here rather than
linked.

| File | Family | Copyright | Upstream |
|---|---|---|---|
| `Inter.ttf` | Inter | Copyright 2020 The Inter Project Authors | https://github.com/rsms/inter |
| `Roboto.ttf` | Roboto | Copyright 2011 The Roboto Project Authors | https://github.com/googlefonts/roboto-classic |
| `SourceSerif4.ttf` | Source Serif 4 | Copyright 2014 The Source Serif 4 Project Authors | https://github.com/adobe-fonts/source-serif |
| `Merriweather.ttf` | Merriweather | Copyright 2020 The Merriweather Project Authors, with Reserved Font Name "Merriweather" | https://github.com/EbenSorkin/Merriweather4 |
| `JetBrainsMono.ttf` | JetBrains Mono | Copyright 2020 The JetBrains Mono Project Authors | https://github.com/JetBrains/JetBrainsMono |

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

These files are therefore the static weight-400 instances Google Fonts serves
to legacy user agents, refetchable with `pnpm --filter @margin/web fonts:fetch`
(see `apps/web/scripts/fetch-fonts.mjs`, which records the exact request).
Combined they are ~340 KB, and a typical document embeds one of them.

Subsetting — which would cut even that to a few KB — needs `pdf-lib` +
`@pdf-lib/fontkit` and is deliberately deferred to Phase 4
(`PHASE-2-DESIGN.md` §0). It is a size optimisation, not a capability.

## Scope

Registered with `addSimpleFont(font, 'Latin')`. Non-Latin scripts are out of
scope for Phase 2 — a stated limitation, not an oversight.
