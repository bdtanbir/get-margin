# Objects that exported but were invisible on screen

Reported as a signature that could be placed, selected and downloaded — and could not be seen in
the editor.

## The defect, and how many times it had happened

`ObjectLayer` maps each object kind to the component that draws it, and its own comment says an
unregistered kind "renders nothing rather than throwing: a half-broken overlay is recoverable, and
the EXPORT path is where an unknown kind must fail loudly". The export uses a completely separate
table (`WRITERS`), so a kind can be exported perfectly and drawn nowhere.

Three kinds had reached the format without a renderer, across three phases:

| Kind | Added | Symptom |
|---|---|---|
| `textPatch` | Phase 6 | An edited line showed the original until downloaded |
| `signature` | Phase 2 | A signature you could place, select, drag and export — and never see |
| `stamp` | Phase 6 | Watermarks, page numbers, headers, footers, Bates numbers: all invisible |

Each was reported by a user. None was caught here.

## Fix

`signature` renders through `ImageObject`, which is what the export already does —
`WRITERS.signature = writeImage`, decided in Phase 2 and never mirrored in the viewer.

`stamp` renders through `TextObject`: `write/objects/stamp.ts` imports `ASCENT_RATIO` from
`write/objects/text.ts` and uses the same baseline formula and the same alignment offset, so the two
agree by construction.

**One difference the preview cannot express.** A stamp with `behind: true` is written with
`prependContent`, under the page's own content; the overlay is always above the page bitmap, so such
a stamp previews on top of what it will sit under. Drawing it in the right place at the wrong depth
beats not drawing it at all, and there is a test recording the difference rather than leaving it to
be discovered.

## The part that matters more than either fix

The renderer table moved out of `ObjectLayer.vue` into `objects/registry.ts`, and `ObjectKind`
became a runtime list (`OBJECT_KINDS`) with the type derived from it rather than a type alone.

Those two changes exist so `objectRenderers.test.ts` can iterate the format's own list of kinds and
assert each one is drawn by something. **A type-only union cannot be enumerated by a test**, and a
table private to a component cannot be read by one — which is why three separate omissions all
reached users.

The test also checks that no kind is in both tables, and that neither table names a kind the format
does not define.

## Verified

Removing either entry turns the suite red with the kind named and the fix spelled out:

```
"signature" has no renderer: add it to COMPONENTS, or to MARKUP_KINDS if its
geometry is in MuPDF page space. An unregistered kind draws nothing and reports no error.
```
