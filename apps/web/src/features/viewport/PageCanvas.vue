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
watchEffect(paint)
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
