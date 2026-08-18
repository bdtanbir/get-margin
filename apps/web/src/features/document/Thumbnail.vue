<script setup lang="ts">
import { computed } from 'vue'
import { pageViewSize } from '@margin/transform'
import { useViewportStore } from '@/stores/viewport'
import type { PageState } from '@/stores/document'
import { cn } from '@/ui/cn'

// Props are `{ page, index, active }` — deliberately no `bitmap` prop.
// `index` is the page's position in `pageOrder` (display order), NOT
// `page.sourceIndex` (original document order). Phase 3 reorders pages, at
// which point the two diverge; everything shown to the user here — the
// label, the emitted `select` payload — must be derived from `index`.
const props = defineProps<{ page: PageState; index: number; active: boolean }>()
const emit = defineEmits<{ select: [number] }>()

const vp = useViewportStore()
// The render queue already produces a cheap placeholder render for every
// page (Task 17) purely so this panel has something to show — `bitmapFor`
// falls back to that placeholder tier when no full render exists yet, so
// this costs nothing extra to open.
const bitmap = computed(() => vp.bitmapFor(props.page.id))

const ratio = computed(() => {
  const { width, height } = pageViewSize(props.page.geometry, 1)
  return `${width} / ${height}`
})

function paintBitmap(el: HTMLCanvasElement | null): void {
  const bmp = bitmap.value
  if (!el || !bmp) return
  const ctx = el.getContext('2d')
  if (!ctx) return
  ctx.putImageData(new ImageData(new Uint8ClampedArray(bmp.rgba), bmp.width, bmp.height), 0, 0)
}
</script>

<template>
  <button
    type="button"
    :aria-current="props.active ? 'true' : undefined"
    :aria-label="`Go to page ${props.index + 1}`"
    class="group flex w-full flex-col items-center gap-1 rounded-panel p-1.5 transition-colors duration-fast
           hover:bg-surface-sunken"
    @click="emit('select', props.index)"
  >
    <div
      data-testid="thumb-frame"
      :class="cn(
        'w-full overflow-hidden rounded-sheet bg-surface ring-1 transition-shadow duration-fast',
        props.active ? 'ring-2 ring-accent' : 'ring-border group-hover:ring-border-strong',
      )"
      :style="{ aspectRatio: ratio }"
    >
      <canvas
        v-if="bitmap"
        :width="bitmap.width"
        :height="bitmap.height"
        class="block size-full object-contain"
        :ref="(el) => paintBitmap(el as HTMLCanvasElement | null)"
      />
      <div v-else class="size-full animate-pulse bg-surface-sunken" />
    </div>
    <span class="text-[11px] tabular-nums text-text-subtle">{{ props.index + 1 }}</span>
  </button>
</template>
