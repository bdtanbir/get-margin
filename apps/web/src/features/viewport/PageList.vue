<script setup lang="ts">
import { computed, watch, onMounted, ref } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { pageViewSize } from '@margin/transform'
import PageCanvas from './PageCanvas.vue'
import { useDocumentStore } from '@/stores/document'
import { useViewportStore } from '@/stores/viewport'

const doc = useDocumentStore()
const vp = useViewportStore()
const scroller = ref<HTMLElement | null>(null)

const GAP = 24

function pageHeight(index: number): number {
  const id = doc.pageOrder[index]
  const geom = id ? doc.pages[id]?.geometry : undefined
  if (!geom) return 800
  return pageViewSize(geom, vp.zoom).height + GAP
}

const virtualizer = useVirtualizer(
  computed(() => ({
    count: doc.pageOrder.length,
    getScrollElement: () => scroller.value,
    estimateSize: pageHeight,
    overscan: 2,
  })),
)

const items = computed(() => virtualizer.value.getVirtualItems())
const totalHeight = computed(() => virtualizer.value.getTotalSize())

// Keep the render anchor pointing at whatever is centred in the viewport.
watch(items, (list) => {
  const first = list[0]
  if (!first) return
  const mid = list[Math.floor(list.length / 2)] ?? first
  vp.setAnchor(mid.index)
  void vp.pump()
})

watch(() => vp.zoom, () => {
  virtualizer.value.measure()
  void vp.pump()
})

onMounted(() => { void vp.pump() })
</script>

<template>
  <div
    ref="scroller"
    class="h-full w-full overflow-auto overscroll-contain bg-canvas"
    tabindex="0"
    role="region"
    aria-label="Document pages"
  >
    <div class="relative mx-auto w-fit py-6" :style="{ height: `${totalHeight}px` }">
      <div
        v-for="item in items"
        :key="doc.pageOrder[item.index]"
        class="absolute left-0 top-0 w-full flex justify-center"
        :style="{ transform: `translateY(${item.start}px)` }"
      >
        <PageCanvas
          v-if="doc.pages[doc.pageOrder[item.index]!]"
          :page="doc.pages[doc.pageOrder[item.index]!]!"
          :zoom="vp.zoom"
          :bitmap="vp.bitmapFor(doc.pageOrder[item.index]!)"
        />
      </div>
    </div>
  </div>
</template>
