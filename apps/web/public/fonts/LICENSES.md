# Bundled fonts

Every family here is licensed under the **SIL Open Font License, Version 1.1**,
whose full text is in [`OFL.txt`](./OFL.txt) beside this file. The OFL requires
the licence to travel with the font, which is why it is vendored here rather
than linked. The copyright column is each file's own `name` table entry, read
out of the file rather than typed in.

The catalogue is `src/lib/fontCatalog.json`: the fetch script reads it to know
what to download, the app reads it to know what to offer, and the test in
`test/lib/fonts.test.ts` checks that every file the catalogue claims exists,
every file that exists is claimed, and every file declares the style its name
says. 236 files, 11.3 MB, fetched on demand -- a document pays only for
the faces it uses.

## Body faces

One file per weight per slope, named `<Base>-<weight>.ttf` and
`<Base>-<weight>Italic.ttf`. The weights column is what Google Fonts publishes
for the family between 100 and 800; a family that stops short is offered
exactly what it has, and moving text to it snaps to the nearest weight.

The six families marked "stands in for" cover the Google Docs menu entries
that are proprietary Microsoft faces -- Arial, Times New Roman, Courier New,
Georgia, Comic Sans MS and Impact -- which Google Fonts does not serve. Each is
the open, metric-compatible face conventionally used in their place, and the
picker shows both names.

| Family | Files | Weights | Italic | Copyright |
|---|---|---|---|---|
| Amatic SC | `AmaticSC-<weight>.ttf` | 400, 700 | no | Copyright 2015 The Amatic SC Project Authors (https://github.com/googlefonts/AmaticSC) |
| Anton (stands in for Impact) | `Anton-<weight>.ttf` | 400 | no | Copyright 2020 The Anton Project Authors (https://github.com/googlefonts/AntonFont.git) |
| Arimo (stands in for Arial) | `Arimo-<weight>.ttf`, `Arimo-<weight>Italic.ttf` | 400, 500, 600, 700 | yes | Copyright 2020 The Arimo Project Authors (https://github.com/googlefonts/arimo) |
| Caveat | `Caveat-<weight>.ttf` | 400, 500, 600, 700 | no | Copyright 2014 The Caveat Project Authors (https://github.com/googlefonts/caveat) |
| Comfortaa | `Comfortaa-<weight>.ttf` | 300, 400, 500, 600, 700 | no | Copyright 2011 The Comfortaa Project Authors (https://github.com/alexeiva/comfortaa), with Reserved Font Name "Comfortaa". |
| Comic Neue (stands in for Comic Sans MS) | `ComicNeue-<weight>.ttf`, `ComicNeue-<weight>Italic.ttf` | 300, 400, 700 | yes | Copyright 2014 The Comic Neue Project Authors (https://github.com/crozynski/comicneue) |
| Cousine (stands in for Courier New) | `Cousine-<weight>.ttf`, `Cousine-<weight>Italic.ttf` | 400, 700 | yes | Copyright 2026 The Cousine Project Authors (https://github.com/googlefonts/cousine) |
| EB Garamond | `EBGaramond-<weight>.ttf`, `EBGaramond-<weight>Italic.ttf` | 400, 500, 600, 700, 800 | yes | Copyright 2017 The EB Garamond Project Authors (https://github.com/octaviopardo/EBGaramond12) |
| Gelasio (stands in for Georgia) | `Gelasio-<weight>.ttf`, `Gelasio-<weight>Italic.ttf` | 400, 500, 600, 700 | yes | Copyright 2022 The Gelasio Project Authors (https://github.com/SorkinType/Gelasio) |
| Inter | `Inter-<weight>.ttf`, `Inter-<weight>Italic.ttf` | 100, 200, 300, 400, 500, 600, 700, 800 | yes | Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) |
| JetBrains Mono | `JetBrainsMono-<weight>.ttf`, `JetBrainsMono-<weight>Italic.ttf` | 100, 200, 300, 400, 500, 600, 700, 800 | yes | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) |
| Lexend | `Lexend-<weight>.ttf` | 100, 200, 300, 400, 500, 600, 700, 800 | no | Copyright 2019 The Lexend Project Authors (https://github.com/googlefonts/lexend) |
| Lobster | `Lobster-<weight>.ttf` | 400 | no | Copyright 2010 The Lobster Project Authors (https://github.com/impallari/The-Lobster-Font), with Reserved Font Name "Lobster". |
| Lora | `Lora-<weight>.ttf`, `Lora-<weight>Italic.ttf` | 400, 500, 600, 700 | yes | Copyright 2011 The Lora Project Authors (https://github.com/cyrealtype/Lora-Cyrillic), with Reserved Font Name "Lora". |
| Merriweather | `Merriweather-<weight>.ttf`, `Merriweather-<weight>Italic.ttf` | 300, 400, 500, 600, 700, 800 | yes | Copyright 2024 The Merriweather Project Authors (https://github.com/EbenSorkin/Merriweather4) with Reserved Font Name "Merriweather". |
| Montserrat | `Montserrat-<weight>.ttf`, `Montserrat-<weight>Italic.ttf` | 100, 200, 300, 400, 500, 600, 700, 800 | yes | Copyright 2011 The Montserrat Project Authors (https://github.com/JulietaUla/Montserrat) |
| Nunito | `Nunito-<weight>.ttf`, `Nunito-<weight>Italic.ttf` | 200, 300, 400, 500, 600, 700, 800 | yes | Copyright 2014 The Nunito Project Authors (https://github.com/googlefonts/nunito) |
| Oswald | `Oswald-<weight>.ttf` | 200, 300, 400, 500, 600, 700 | no | Copyright 2016 The Oswald Project Authors (https://github.com/googlefonts/OswaldFont) |
| Pacifico | `Pacifico-<weight>.ttf` | 400 | no | Copyright 2018 The Pacifico Project Authors (https://github.com/googlefonts/Pacifico) |
| Playfair Display | `PlayfairDisplay-<weight>.ttf`, `PlayfairDisplay-<weight>Italic.ttf` | 400, 500, 600, 700, 800 | yes | Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display), with Reserved Font Name "Playfair Display". |
| Roboto | `Roboto-<weight>.ttf`, `Roboto-<weight>Italic.ttf` | 100, 200, 300, 400, 500, 600, 700, 800 | yes | Copyright 2011 The Roboto Project Authors (https://github.com/googlefonts/roboto-classic) |
| Roboto Mono | `RobotoMono-<weight>.ttf`, `RobotoMono-<weight>Italic.ttf` | 100, 200, 300, 400, 500, 600, 700 | yes | Copyright 2015 The Roboto Mono Project Authors (https://github.com/googlefonts/robotomono) |
| Roboto Serif | `RobotoSerif-<weight>.ttf`, `RobotoSerif-<weight>Italic.ttf` | 100, 200, 300, 400, 500, 600, 700, 800 | yes | Copyright 2020 The Roboto Serif Project Authors (https://github.com/googlefonts/RobotoSerif) |
| Source Serif 4 | `SourceSerif4-<weight>.ttf`, `SourceSerif4-<weight>Italic.ttf` | 200, 300, 400, 500, 600, 700, 800 | yes | © 2014 - 2021 Adobe Systems Incorporated (http://www.adobe.com/), with Reserved Font Name ‘Source’. |
| Spectral | `Spectral-<weight>.ttf`, `Spectral-<weight>Italic.ttf` | 200, 300, 400, 500, 600, 700, 800 | yes | Copyright 2017 The Spectral Project Authors (https://github.com/productiontype/Spectral) |
| Tinos (stands in for Times New Roman) | `Tinos-<weight>.ttf`, `Tinos-<weight>Italic.ttf` | 400, 700 | yes | Copyright 2026 The Tinos Project Authors (https://github.com/googlefonts/tinos) |

### Why real files and not synthesised styles

A viewer asked for a weight or an italic with only the regular loaded draws
a *faux* face — it strokes the outlines for weight, shears them for italic.
That is cheap and it is wrong here for a reason that is not aesthetic: a
synthesised face keeps the **regular's advance widths**, so a centred or
right-aligned line would be positioned by the writer's `measure()` against
metrics that do not describe the ink on the page. The preview would agree
with the export and both would be visibly off-centre.

An italic is its own file at every weight rather than the upright on a slant,
because that is what a type designer draws: in a serif face the italic is a
different alphabet, not the roman leaning over. Compare Source Serif 4's
roman `a` with its italic one.

Fetched from the **v1** CSS endpoint, which takes styles as a bare list:
`:400`, `:700`, `:400italic`, `:700italic`. `:wght@700` is css2 syntax and
the v1 endpoint ignores it and serves weight 400 instead — silently, because
what comes back is still a perfectly valid TrueType. `fonts.test.ts` reads
each file's own OS/2 weight class and its fsSelection ITALIC bit so that
mistake cannot be committed twice. (Inter's Thin and ExtraLight both declare
a weight class of 250, a workaround for a Windows renderer that faux-bolded
anything lighter, so the test holds the two lightest weights to "under 300"
rather than to the exact number.)

Note that `post.italicAngle` is **not** what identifies an italic: Roboto's
italic declares an angle of 0 and is unmistakably slanted. The fsSelection
ITALIC bit is the signal, and it is what MuPDF's `isItalic()` reads when the
app detects the style of text a document already contains.

## Signature script faces (browser-only)

Offered by the typed-signature tab alongside Caveat, and **never embedded in
a PDF**: a typed signature is rasterised to a transparent PNG and placed as an
image, so the face is needed only to draw that raster. They are deliberately
absent from the text tool's font picker — a signature script is not body copy
— and `fontsForExport` filters them out so one can never reach the writer.
Caveat is in both lists because Google Docs offers it as a body face.

| Family | Files | Weights | Italic | Copyright |
|---|---|---|---|---|
| Dancing Script | `DancingScript-<weight>.ttf` | 400 | no | Copyright 2016 The Dancing Script Project Authors (https://github.com/googlefonts/DancingScript), with Reserved Font Name "Dancing Script". |
| Great Vibes | `GreatVibes-<weight>.ttf` | 400 | no | Copyright 2010 The Great Vibes Pro Project Authors (https://github.com/googlefonts/great-vibes) |

## Why these files, self-hosted

Spec §2.5: the preview and the export must use **byte-identical** font files,
and opening a document must make no third-party request. Both rule out a CDN.
The browser loads these via `FontFace` for on-screen measurement; the worker
embeds these same bytes into the exported PDF. One file, two consumers.

## Why static instances, not the variable fonts

`google/fonts` now publishes only variable TTFs for most of these families.
They work — MuPDF loads them and renders the default instance correctly — but
`addSimpleFont` embeds the **entire** font program with no subsetting (Phase 0
measured 57–65% of raw size, and `subsetFonts()` makes no difference for a
freshly registered font). Variable Merriweather is 4.6 MB, so a document with
one line of text in it would carry roughly 3 MB of font.

These files are therefore the static instances Google Fonts serves to legacy
user agents, refetchable with `pnpm --filter @margin/web fonts:fetch`
(see `apps/web/scripts/fetch-fonts.mjs`, which records the exact request).
A typical document embeds one or two of them.

Subsetting — which would cut each to a few KB — needs `pdf-lib` +
`@pdf-lib/fontkit` and is deliberately deferred to Phase 4
(`PHASE-2-DESIGN.md` §0). It is a size optimisation, not a capability.

## Scope

Registered with `addSimpleFont(font, 'Latin')`. Non-Latin scripts are out of
scope for Phase 2 — a stated limitation, not an oversight.
