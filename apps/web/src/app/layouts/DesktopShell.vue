<script setup lang="ts">
import { ref } from 'vue'
import TopBar from '../TopBar.vue'
import PageList from '@/features/viewport/PageList.vue'
import ZoomPill from '@/features/viewport/ZoomPill.vue'
import ThumbnailPanel from '@/features/document/ThumbnailPanel.vue'
import { useDocumentStore } from '@/stores/document'

const doc = useDocumentStore()
const panelOpen = ref(true)

// Amendment A2: PageList (features/viewport/PageList.vue) already owns a
// ResizeObserver on its own scroller element and re-runs `vp.applyFit` on
// resize, fit-mode change, and document-ready. A second observer here,
// watching a different element (this shell's `workspace` wrapper), would
// give two independent `dirty`-marking paths racing to call `vp.pump()`
// against the same store, and risks the two measurements (this wrapper's
// box vs. PageList's own scroller box) silently diverging. The shell's only
// job is to give PageList a properly sized ancestor (via ordinary flex
// layout below) — PageList fills it and measures itself.
</script>

<template>
  <div class="flex h-dvh flex-col">
    <TopBar :panel-open="panelOpen" @toggle-panel="panelOpen = !panelOpen" />
    <div class="flex min-h-0 flex-1">
      <!-- Phase 2 inserts the 64px tool rail here. -->
      <ThumbnailPanel v-if="panelOpen && doc.isReady" />
      <!--
        Amendment A3: ZoomPill is floating chrome (`absolute`, positioned
        via `bottom-4 right-4` below) that does not reduce PageList's CSS
        box, so a fit computed from the workspace's full clientWidth/
        clientHeight leaves no room for it and the pill can overlap the
        last row of a fitted page. `p-4 pb-16` gives the workspace (and
        therefore PageList, which fills it, per the Task 20 PageList.vue
        change) a real inset, biased toward the bottom edge where the pill
        actually floats.
        The bottom number is not arbitrary: `lib/fit.ts`'s own
        DEFAULT_PADDING (32px) already reserves margin around the fitted
        page on every side, and the pill's own footprint from this
        element's edge is `bottom-4` (16px) + its rendered height (42px) =
        58px. For the pill to never sit over content, bottom padding + 32
        must be >= 58px, i.e. padding >= 26px; `pb-16` (64px) clears that
        with real margin to spare. Verified empirically in a real browser
        (a fit-page page's bottom edge vs. the pill's bounding box, and a
        deliberately-too-small `p-4`-only version that produced a
        measurable overlap) before landing here.
      -->
      <main class="relative min-w-0 flex-1 overflow-hidden p-4 pb-16">
        <PageList />
        <div class="pointer-events-none absolute bottom-4 right-4 z-20">
          <ZoomPill />
        </div>
      </main>
      <!-- Phase 2 inserts the 320px inspector here. -->
    </div>
  </div>
</template>
