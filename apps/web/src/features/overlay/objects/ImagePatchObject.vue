<script setup lang="ts">
import { computed, watch, onBeforeUnmount, shallowRef } from 'vue'
import type { ImagePatchObject } from '@margin/pdf-core'
import { rgb } from './svgPaint'

/**
 * What a patch over one of the document's own images looks like on screen.
 *
 * It mirrors `write/objects/imagePatch.ts` deliberately, down to the bleed,
 * because the whole point is to show what the export will produce. Where
 * the two could drift they share a number: `BLEED_PT` is the writer's
 * constant, restated here with the same name and the same value, and
 * `ImagePatchObject.test.ts` holds them together.
 *
 * COVER AND REDRAW, not removal. The document's own image is still in the
 * page bitmap underneath; this paints over it. The same distinction the
 * text patch and whiteout both carry, and the privacy page depends on it.
 *
 * Geometry is MuPDF PAGE space (top-down), taken from where the page draws
 * the image, so this renders OUTSIDE the overlay's y-flipped root <g> --
 * the same treatment markup, redaction and text patches get. That is also
 * why there is no `scale(1,-1)` here where `ImageObject.vue` needs one: a
 * raster drawn inside the flipped root would be upside down, and one drawn
 * outside it is not.
 */
const props = defineProps<{ object: ImagePatchObject }>()

/** The writer's own constant. See write/objects/imagePatch.ts. */
const BLEED_PT = 0.75

/**
 * How far the copy has been dragged from the image it replaces.
 *
 * ADDED to y here, where the writer SUBTRACTS it: this renders in page
 * space, which is top-down, while a content stream is bottom-up. Two
 * opposite signs for the same movement, exactly as the text patch pair.
 *
 * It moves the COPY only. The cover below keeps the un-offset rect,
 * because the document's own image is still under it and dragging the
 * cover along would uncover it.
 */
const dx = computed(() => props.object.offset?.dx ?? 0)
const dy = computed(() => props.object.offset?.dy ?? 0)

const cover = computed(() => {
  const { x, y, w, h } = props.object.rect
  return {
    x: x - BLEED_PT,
    y: y - BLEED_PT,
    width: w + BLEED_PT * 2,
    height: h + BLEED_PT * 2,
  }
})

const placed = computed(() => {
  const { x, y, w, h } = props.object.rect
  return { x: x + dx.value, y: y + dy.value, width: w, height: h }
})

/**
 * An object URL, not a data URL, for the same reason `ImageObject.vue`
 * uses one: base64 is a third larger than the payload and would be
 * re-encoded on every re-render, which a drag does sixty times a second.
 */
const href = shallowRef('')
let current = ''

function revoke(): void {
  if (current) URL.revokeObjectURL(current)
  current = ''
}

watch(
  () => props.object.data,
  (data) => {
    revoke()
    if (!data || data.length === 0) {
      href.value = ''
      return
    }
    // Copy into a fresh buffer: the store's Uint8Array is a view that Immer
    // freezes, and Blob keeps a reference to whatever it is handed.
    current = URL.createObjectURL(new Blob([data.slice()], { type: props.object.mime ?? 'image/png' }))
    href.value = current
  },
  { immediate: true },
)

onBeforeUnmount(revoke)
</script>

<template>
  <!--
    The cover always. A deleted image is this rectangle and nothing else,
    which is why the <image> below is conditional rather than the whole
    component being two components.
  -->
  <rect
    :x="cover.x"
    :y="cover.y"
    :width="cover.width"
    :height="cover.height"
    :fill="rgb(props.object.background)"
  />
  <image
    v-if="href"
    :href="href"
    :x="placed.x"
    :y="placed.y"
    :width="placed.width"
    :height="placed.height"
    preserveAspectRatio="none"
  />
</template>
