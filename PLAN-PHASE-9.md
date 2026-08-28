# Phase 9 — the document's own images

Phase 8 gave the user the document's own *text*: select a line, retype it,
restyle it, drag it somewhere else. Its images stayed inert. This phase
gives them the other half — delete an image the document came with, then
move it — and it is deliberately built as the same shape as the text patch
rather than as a new mechanism.

## What was measured first

A real US-Bangla e-ticket, probed with a custom MuPDF device. Three
findings, each of which would have been discovered the expensive way:

1. **`onImageBlock` over-reports.** Structured text claimed three image
   blocks on page 1; the page draws two. The third is the grey gradient
   behind the Travel Note box — MuPDF rasterises a `fillShade` op into a
   synthetic image block. Offering "delete" on it would be a lie: the
   shading is drawn by the content stream and would come straight back.
   **So the index is built from a `Device`, not from structured text.**

2. **The images are not in the page's own resources.** Page 1's
   `/Resources /XObject` holds `/Fm1` and `/Fm2` — two *form* XObjects,
   with the images one level down inside them. (This is also the bug fixed
   in `14204d6`: the compressor's page-only walk found nothing to
   compress on exactly these files.)

3. **Transparency comes from a stencil clip, not from the image.** Every
   image on the page is drawn as `clipImageMask` then `fillImage`. The
   image itself carries no alpha — dumping its pixmap gives a black
   background. Re-placing it by emitting a bare `cm` + `/Do` would paint a
   black box behind the logo.

Findings 2 and 3 together kill the obvious implementation of *move*
("re-reference the existing XObject at a new CTM"): the lookup is nested,
the mask is lost, and page 2's image is Indexed CMYK, which is exactly the
case `compress.ts` already documents as failing to round-trip.

## The approach

**Cover and redraw**, the same as `write/objects/patch.ts`, and for the
same reason: it is the mechanism the codebase already trusts.

- **Delete** is the cover alone — an opaque rect in the sampled background
  colour over the image's box.
- **Move** is the cover plus a *rasterised* copy of the image redrawn at
  an offset. Rasterising the page region sidesteps the nested lookup, the
  stencil mask, and the exotic colour space in one move, because it asks
  the renderer for the pixels a reader would actually see.

Both are ONE object kind, `imagePatch`, because they are one user action
with a redraw switched off — and because two kinds would mean two entries
in the layers list for what the user thinks of as one edit.

### The guard

A patch is addressed by *position in draw order*, which is not stable
across a document that has been edited elsewhere. So `imagePatch` carries
`originalHash` — the image's pixel dimensions and its placement box,
hashed — and the writer re-walks the assembled page at export and
**refuses** if the image at that index no longer hashes the same.

This is `PatchRefused`, reused verbatim. `PLAN.md` §2.4: fail loudly,
never silently mispatch. Covering whatever happens to be at index 2 now is
the worst outcome available.

### What it does NOT do

**It covers; it does not remove.** The image stream is still in the file
and still extractable, exactly as `writeWhiteout` and every text patch
already are. This is a layout tool, not redaction — and the UI has to say
so, because "delete" is a word that invites the other reading. Genuine
removal would be `applyRedactions`, whose image path `objects/redact.ts`
already documents as untrusted.

## Tasks

### Delete

1. `src/images/index.ts` — `pageImages(page)`, a `Device` walk returning
   an `ImagePlacement[]` in draw order: box in MuPDF page space, source
   pixel dimensions, and the identity hash. Space pinned by a test against
   `onImageBlock` on a rotated page and an offset CropBox.
2. `ImagePatchObject` in the format; registered in `OBJECT_KINDS`, the
   `EditObject` union, `WRITERS`, `MARKUP_KINDS`, and the layer label and
   icon tables.
3. `write/objects/imagePatch.ts` — re-walk, guard, cover.
4. Worker: `pageImages(sourceId, index)`, plumbed like `quadIndex`.
5. Overlay: hover and click an image to select it; Delete removes it. The
   background is sampled with the existing `sampleBackground`, and its
   confidence drives the same warning the text patch shows.

### Move

6. Worker: `imageCrop(sourceId, pageIndex, imageIndex, scale)` — render
   the page, crop the image's box, return PNG. Scale chosen so the crop is
   no coarser than the source: the ticket's logo is 1200px placed at
   207.8pt, ≈5.8x, so ~6x.
7. `data` + `offset` on the object; the writer redraws through the
   existing `writeImage` XObject cache.
8. Drag to move, reusing `SelectionChrome`'s patch-move gesture.

### Lift (added after page 2)

The image tool cannot reach what is not an image, and a great deal of what
a reader calls "the logo" is not one. Page 2 of the same e-ticket draws
the logo page 1 embeds as a 1200x286 raster using **21 vector paths**, so
`fillImage` never fires for it and no image index can offer it.

Clustering those paths into "the logo" is a heuristic, and every heuristic
eventually takes the rule beside them. So the boundary is drawn instead:

9. `cropRegion` -- any rectangle of the page, rendered. Shares
   `renderRegion` with `cropImage`; caps itself at 4M pixels by dropping
   the scale rather than refusing.
10. `RegionPatchObject` -- the same fields as an image patch minus the
    address, because `rect` IS the address. No hash guard, and that is a
    real difference rather than an omission: an image patch is addressed
    by position in a walk, a region by its own geometry.
11. `coverArea.ts` -- the drawing both patch kinds share, so they cannot
    drift by a bleed or a sign.
12. The Lift area tool: drag a box, it lifts as one piece, and the select
    tool arrives with it already selected.
