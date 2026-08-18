<script setup lang="ts">
import { computed, watch, onMounted, onBeforeUnmount, ref } from 'vue'
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

// Task 19: ThumbnailPanel jumps the viewport by calling `vp.setAnchor`
// directly (it has no reference to this component or its scroller). For an
// already-visible page that is a no-op — the watcher above already keeps
// the anchor in sync with scroll position — but for a thumbnail far outside
// the current viewport, `setAnchor` alone changes only the store's number;
// nothing scrolls the container. `align: 'auto'` is what makes this safe to
// run on every anchor change without fighting the user's own scrolling: per
// tanstack-virtual, 'auto' is a no-op when the target index is already
// fully in view (which it will be for scroll-driven anchor updates, since
// those originate from `items` above), and only actually scrolls when the
// index is genuinely off-screen (a thumbnail-driven jump).
watch(() => vp.anchorIndex, (i) => {
  virtualizer.value.scrollToIndex(i, { align: 'auto' })
})

watch(() => vp.zoom, () => {
  virtualizer.value.measure()
  void vp.pump()
})

// Task 18: fit modes need a container size and a reference page geometry to
// resolve into an actual zoom number. There is no dedicated shell yet
// (Task 20) to own "on resize, re-fit" — PageList owns the scrolling
// container, so it owns this until that shell exists. Uses the anchor
// page's geometry (falling back to the first page) rather than assuming
// every page in the document shares one size.
function referenceGeometry() {
  const id = doc.pageOrder[vp.anchorIndex] ?? doc.pageOrder[0]
  return id ? doc.pages[id]?.geometry : undefined
}

function refit(): void {
  const el = scroller.value
  const geometry = referenceGeometry()
  if (!el || !geometry) return
  vp.applyFit(el.clientWidth, el.clientHeight, geometry)
}

watch(() => vp.fitMode, refit)

let resizeObserver: ResizeObserver | undefined

onMounted(() => {
  void vp.pump()
  refit()
  if (typeof ResizeObserver !== 'undefined' && scroller.value) {
    resizeObserver = new ResizeObserver(() => refit())
    resizeObserver.observe(scroller.value)
  }
})

onBeforeUnmount(() => resizeObserver?.disconnect())
</script>

<template>
  <!--
    Owns its own height (h-dvh) rather than trusting a caller-supplied class
    — a caller-passed height utility landing on this same root element would
    collide with one hardcoded here, with Tailwind's generated-CSS order
    (not usage order) silently deciding the winner. A future shell that
    embeds PageList beside other chrome (Task 20) should wrap it in a sized
    container rather than pass conflicting height classes through.
  -->
  <div
    ref="scroller"
    class="h-dvh w-full overflow-auto overscroll-contain bg-canvas"
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
