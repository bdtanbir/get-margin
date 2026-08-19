<script setup lang="ts">
import { computed, watch, onBeforeUnmount, shallowRef } from 'vue'
import type { ImageObject } from '@margin/pdf-core'

const props = defineProps<{ object: ImageObject }>()

const href = shallowRef('')
let current = ''

/**
 * An object URL, not a data URL: a base64 data URL is a third larger than
 * the payload and has to be re-encoded into a string on every re-render,
 * which a drag does sixty times a second.
 */
function revoke(): void {
  if (current) URL.revokeObjectURL(current)
  current = ''
}

watch(
  () => props.object.data,
  (data) => {
    revoke()
    // Copy into a fresh buffer: the store's Uint8Array is a view that Immer
    // freezes, and Blob keeps a reference to whatever it is handed.
    current = URL.createObjectURL(new Blob([data.slice()], { type: props.object.mime }))
    href.value = current
  },
  { immediate: true },
)

onBeforeUnmount(revoke)

const rect = computed(() => props.object.rect)
</script>

<template>
  <!--
    The overlay's root <g> carries a y-flip, so a raster drawn through it
    would appear upside down. scale(1,-1) undoes it locally and the y is
    negated to compensate -- the same trick TextObject.vue uses for glyphs.
    preserveAspectRatio="none" because the rect is the authority on size:
    the writer's CTM stretches the image to exactly this box, so the preview
    must not letterbox where the export will not.
  -->
  <image
    :href="href"
    :x="rect.x"
    :y="-(rect.y + rect.h)"
    :width="rect.w"
    :height="rect.h"
    transform="scale(1,-1)"
    preserveAspectRatio="none"
  />
</template>
