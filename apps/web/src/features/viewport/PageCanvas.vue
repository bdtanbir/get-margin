<script setup lang="ts">
import { computed, ref, watchEffect, onMounted } from 'vue'
import { pageViewSize } from '@margin/transform'
import type { PageState } from '@/stores/document'
import type { RenderResult } from '@/workers/pdfService'

const props = defineProps<{
  page: PageState
  zoom: number
  bitmap?: RenderResult | undefined
}>()

const canvas = ref<HTMLCanvasElement | null>(null)

/** Logical CSS size. Always derived from geometry — never from the bitmap. */
const view = computed(() => pageViewSize(props.page.geometry, props.zoom))
const cssWidth = computed(() => `${Math.round(view.value.width)}px`)
const cssHeight = computed(() => `${Math.round(view.value.height)}px`)

const label = computed(() => `Page ${props.page.sourceIndex + 1}`)

function paint(): void {
  const el = canvas.value
  const bmp = props.bitmap
  if (!el || !bmp) return
  const ctx = el.getContext('2d')
  if (!ctx) return
  const data = new ImageData(new Uint8ClampedArray(bmp.rgba), bmp.width, bmp.height)
  ctx.putImageData(data, 0, 0)
}

onMounted(paint)
// flush: 'post' (Task 19 fix — see PageCanvas paint-clear race in the Task
// 19 report). Default ('pre') flush timing runs this BEFORE the
// component's own render effect patches `:width`/`:height` on the canvas
// element below. When `props.bitmap` changes to a bitmap with DIFFERENT
// dimensions than the currently-mounted canvas (e.g. a placeholder-tier
// render being replaced by a full-tier one for a page that is already on
// screen — exactly what happens when ThumbnailPanel jumps the viewport to
// a page whose canvas is already mounted), the two pre-flush jobs raced:
// `paint()` ran first and drew onto the OLD-sized canvas, then the
// component's own patch immediately resized the `<canvas>` element to the
// new bitmap's dimensions — which the HTML canvas spec defines as
// resetting the bitmap to fully transparent — silently wiping out the
// paint that had just happened. The result was a canvas with the correct
// (new, full-resolution) width/height but permanently blank content: no
// error, no console warning, structurally identical to a working page.
// `flush: 'post'` makes this watcher run AFTER the DOM patch (the same
// timing `onMounted` already uses for the very first paint), so it always
// draws onto the canvas at its final, already-resized dimensions.
watchEffect(paint, { flush: 'post' })
</script>

<template>
  <div
    role="img"
    :aria-label="label"
    class="relative shrink-0 overflow-hidden rounded-sheet bg-surface ring-1 ring-border shadow-low"
    :style="{ width: cssWidth, height: cssHeight }"
  >
    <canvas
      v-if="props.bitmap"
      ref="canvas"
      :width="props.bitmap.width"
      :height="props.bitmap.height"
      :style="{ width: cssWidth, height: cssHeight }"
      class="block"
    />
    <!-- Placeholder occupies the exact final size, so nothing shifts on arrival. -->
    <div v-else class="size-full animate-pulse bg-surface-sunken" />
  </div>
</template>
