<script setup lang="ts">
import { computed, watch, onMounted, onBeforeUnmount, ref } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { pageViewSize } from '@margin/transform'
import PageCanvas from './PageCanvas.vue'
import PageOverlay from '@/features/overlay/PageOverlay.vue'
import { useDocumentStore } from '@/stores/document'
import { useViewportStore } from '@/stores/viewport'
import { useGestures } from './useGestures'

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

/**
 * Keep the anchor pointing at whatever is actually centred in the viewport.
 *
 * This used to take `list[Math.floor(list.length / 2)]` -- the middle of
 * the virtual items ARRAY, which is the visible range plus overscan and is
 * not centred on anything. At the top of a document the array is
 * [0,1,2,3,4], so the "centre" resolved to index 2, and because that number
 * was fed back into a scroll, opening a document scrolled it to page 3 on
 * its own and clicking page 1 landed on page 3.
 *
 * The real answer is the item whose extent contains the middle of the
 * scrolled viewport, which is what this computes.
 */
watch(items, (list) => {
  const first = list[0]
  if (!first) return
  const el = scroller.value
  // `scrollOffset` is null until the scroller has been measured; treat that
  // as the top rather than as NaN, which would make every comparison below
  // false and silently pin the anchor to the first item.
  const offset = virtualizer.value.scrollOffset ?? 0
  const middle = offset + (el ? el.clientHeight / 2 : 0)
  const centred = list.find((item) => item.start <= middle && item.end > middle)
  // Past the end (short document, or bounced scroll) the nearest item is
  // the last one that starts before the middle.
  const fallback = [...list].reverse().find((item) => item.start <= middle) ?? first
  vp.setAnchor((centred ?? fallback).index)
  void vp.pump()
})

/**
 * Scroll only when something explicitly asked to navigate.
 *
 * Watches `scrollRequest`, never `anchorIndex`. Watching the anchor meant
 * every scroll-driven update was read back as an instruction to scroll, so
 * the scroller fought itself; `align: 'auto'` was the workaround, and it
 * silently swallowed any real navigation to a page that was already partly
 * on screen -- clicking the next page down did nothing at all.
 *
 * `align: 'start'` because "go to page 8" means put page 8 at the top, the
 * way every other PDF reader behaves. The nonce in the request is what
 * makes asking for the same page twice scroll twice.
 */
watch(() => vp.scrollRequest, (request) => {
  if (!request) return
  virtualizer.value.scrollToIndex(request.index, { align: 'start' })
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

/**
 * Touch gestures on the scroller.
 *
 * Zoom goes through `vp.setZoom`, and panning through the scroller's own
 * scroll position, so no coordinate maths lives here -- the gesture
 * composable reports a RELATIVE scale and this multiplies the current zoom
 * by it.
 *
 * Only touch: a mouse already has the wheel and the zoom controls, and
 * claiming its drags here would break text selection and object dragging.
 */
const gestures = useGestures({
  onPinch: (scale) => {
    vp.setFitMode('custom')
    vp.setZoom(vp.zoom * scale)
  },
  onPan: ({ dx, dy }) => {
    const el = scroller.value
    if (!el) return
    el.scrollLeft -= dx
    el.scrollTop -= dy
  },
})

function isTouch(e: PointerEvent): boolean {
  return e.pointerType === 'touch'
}

function onPointerDown(e: PointerEvent): void {
  if (isTouch(e)) gestures.onPointerDown(e)
}

function onPointerMove(e: PointerEvent): void {
  if (!isTouch(e)) return
  // Only claim the event once a gesture is genuinely in progress, so a
  // single tap still reaches whatever is underneath.
  if (gestures.contacts.value.length > 0) {
    if (gestures.contacts.value.length > 1) e.preventDefault()
    gestures.onPointerMove(e)
  }
}

function onPointerUp(e: PointerEvent): void {
  if (isTouch(e)) gestures.onPointerUp(e)
}

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  gestures.reset()
})
</script>

<template>
  <!--
    Task 20: fills its container (h-full) rather than claiming the whole
    viewport itself (the pre-shell `h-dvh` this used to carry). `h-dvh` is
    an absolute unit — it does not shrink for a sibling TopBar the way a
    flex-stretched ancestor's box does, so once DesktopShell/MobileShell
    added real chrome above/around this component, a `h-dvh` root rendered
    taller than its actual on-screen space and silently overflowed past it
    (verified in a real browser: scroller bottom at 972px against a 900px
    viewport). `h-full` instead takes its size from whatever ancestor the
    shell gives it, which is exactly what DesktopShell/MobileShell provide
    via ordinary flex layout (a `flex-1 min-h-0` chain up to the `h-dvh`
    shell root) — this component still owns measuring itself via its own
    ResizeObserver (see `refit` above); it no longer disagrees with its
    ancestor about how tall it is while doing so.
  -->
  <div
    ref="scroller"
    class="h-full w-full overflow-auto overscroll-contain bg-canvas"
    tabindex="0"
    role="region"
    aria-label="Document pages"
    style="touch-action: pan-x pan-y"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <div class="relative mx-auto w-fit py-6" :style="{ height: `${totalHeight}px` }">
      <div
        v-for="item in items"
        :key="doc.pageOrder[item.index]"
        class="absolute left-0 top-0 w-full flex justify-center"
        :style="{ transform: `translateY(${item.start}px)` }"
      >
        <div class="relative">
          <PageCanvas
            v-if="doc.pages[doc.pageOrder[item.index]!]"
            :page="doc.pages[doc.pageOrder[item.index]!]!"
            :index="item.index"
            :zoom="vp.zoom"
            :bitmap="vp.bitmapFor(doc.pageOrder[item.index]!)"
          />
          <!--
            Spec 1.3: only pages within +/-1 of the anchor mount an overlay.
            Pages outside that window keep their bitmap and drop their objects
            from the DOM, which is what keeps a 300-page annotated document
            responsive. `overscan: 2` on the virtualizer means `items` is
            already wider than this window, so the guard is a real filter, not
            a no-op.
          -->
          <PageOverlay
            v-if="doc.pages[doc.pageOrder[item.index]!] && Math.abs(item.index - vp.anchorIndex) <= 1"
            :page="doc.pages[doc.pageOrder[item.index]!]!"
            :zoom="vp.zoom"
          />
        </div>
      </div>
    </div>
  </div>
</template>
