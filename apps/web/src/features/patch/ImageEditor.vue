<script setup lang="ts">
import { computed } from 'vue'
import { nanoid } from 'nanoid'
import type { EditObject, ImagePatchObject, PageImageIndex } from '@margin/pdf-core'
import type { PageState } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useViewportStore } from '@/stores/viewport'
import { sampleBackground, CONFIDENT_ENOUGH } from './sampleBackground'
import { plainColor } from './linePatch'

/**
 * One click target per image the document draws, while the Edit image tool
 * is active.
 *
 * The sibling of `PatchEditor`, and the same shape: a layer of targets over
 * what the page already contains, mounted only while its tool is active
 * because a permanent layer of hit targets over every page would swallow
 * every other interaction.
 *
 * Clicking covers the image; clicking a covered one uncovers it again. A
 * toggle rather than a one-way door because the cover is cosmetic and
 * reversible, and because a tool whose only feedback is "the thing you
 * clicked is gone" is a tool people are afraid to try.
 */
const props = defineProps<{
  page: PageState
  zoom: number
  index: PageImageIndex | undefined
}>()

const edits = useEditsStore()
const vp = useViewportStore()

/**
 * How far out the background is sampled from an image's edge, in points.
 *
 * A cap, passed to `sampleBackground`, which would otherwise reach a third
 * of the box's height in every direction -- 33pt for a 100pt logo, far
 * enough to swallow a neighbouring table and report the paper behind the
 * logo as "varied".
 */
const SAMPLE_BAND_PT = 6

/** The patch covering an image, if the user has already removed it. */
function patchOn(imageIndex: number): ImagePatchObject | undefined {
  for (const o of Object.values(edits.doc.objects)) {
    if (o.kind === 'imagePatch' && o.pageId === props.page.id && o.imageIndex === imageIndex) {
      return o
    }
  }
  return undefined
}

const placements = computed(() => props.index?.images ?? [])

/**
 * What is behind an image, sampled from the page AS RENDERED.
 *
 * Done here rather than in the writer for the same reason the text patch
 * does it here: the app already has the pixels on screen, and the writer
 * would have to rasterise a page per patch to learn the same thing.
 */
function backgroundFor(bbox: readonly [number, number, number, number]) {
  const bitmap = vp.bitmapFor(props.page.id)
  const scale = bitmap ? bitmap.scale : 1
  return sampleBackground(
    bitmap,
    { x: bbox[0], y: bbox[1], w: bbox[2] - bbox[0], h: bbox[3] - bbox[1] },
    scale,
    SAMPLE_BAND_PT * scale,
  )
}

/** Whether a flat cover over this image is likely to show. */
function risky(bbox: readonly [number, number, number, number]): boolean {
  return backgroundFor(bbox).confidence < CONFIDENT_ENOUGH
}

function toggle(imageIndex: number): void {
  const existing = patchOn(imageIndex)
  if (existing) {
    edits.applyOp({ type: 'deleteObject', id: existing.id }, 'Restore image')
    return
  }

  const place = placements.value[imageIndex]
  if (!place) return
  const background = backgroundFor(place.bbox)

  const object: ImagePatchObject = {
    id: nanoid(10),
    pageId: props.page.id,
    kind: 'imagePatch',
    imageIndex,
    // Taken from the placement as it is RIGHT NOW, which is what makes the
    // writer's guard meaningful rather than circular: it re-walks the page
    // at export and refuses if the image there is no longer this one.
    originalHash: place.hash,
    background: plainColor(background.color),
    backgroundConfidence: background.confidence,
    rect: {
      x: place.bbox[0],
      y: place.bbox[1],
      w: place.bbox[2] - place.bbox[0],
      h: place.bbox[3] - place.bbox[1],
    },
    rotation: 0,
    z: edits.nextZ(),
    locked: false,
    opacity: 1,
  }
  edits.applyOp({ type: 'addObject', object: object as EditObject }, 'Remove image')
}
</script>

<template>
  <div class="pointer-events-none absolute inset-0" data-image-layer>
    <!--
      Marked by confidence BEFORE the user commits, exactly as the line
      targets are: an image over a gradient can be covered, but the flat
      rectangle will show, and finding that out in the exported file is
      finding out too late.
    -->
    <button
      v-for="place in placements"
      :key="place.index"
      type="button"
      class="pointer-events-auto absolute cursor-pointer border-2 border-dashed transition-colors"
      :class="patchOn(place.index)
        ? 'border-accent bg-accent/20'
        : risky(place.bbox)
          ? 'border-warning/70 hover:bg-warning/20'
          : 'border-accent/40 hover:bg-accent/15'"
      :style="{
        left: `${place.bbox[0] * props.zoom}px`,
        top: `${place.bbox[1] * props.zoom}px`,
        width: `${(place.bbox[2] - place.bbox[0]) * props.zoom}px`,
        height: `${(place.bbox[3] - place.bbox[1]) * props.zoom}px`,
      }"
      :data-image-target="place.index"
      :title="patchOn(place.index)
        ? 'Bring this image back'
        : risky(place.bbox)
          ? 'Remove this image — the area behind it is not a flat colour, so the cover may show'
          : 'Remove this image'"
      :aria-label="patchOn(place.index)
        ? `Bring back image ${place.index + 1}`
        : `Remove image ${place.index + 1}`"
      :aria-pressed="patchOn(place.index) ? 'true' : 'false'"
      @click="toggle(place.index)"
    />
  </div>
</template>
