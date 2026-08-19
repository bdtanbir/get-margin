<script setup lang="ts">
import { ref } from 'vue'
import TopBar from '../TopBar.vue'
import PageList from '@/features/viewport/PageList.vue'
import ZoomPill from '@/features/viewport/ZoomPill.vue'
import ThumbnailPanel from '@/features/document/ThumbnailPanel.vue'
import ToolRail from '@/features/tools/ToolRail.vue'
import Inspector from '@/features/tools/Inspector.vue'
import { useDocumentStore } from '@/stores/document'
import { useViewportShortcuts } from '@/features/viewport/useViewportShortcuts'

const doc = useDocumentStore()
const panelOpen = ref(true)

// Task 21: keyboard shortcuts are desktop-only (no physical keyboard
// assumption on the mobile shell) and read-only (zoom/fit), matching the
// read-only surface Phase 1 exposes. See useViewportShortcuts.ts for why
// this alone is sufficient scoping — no extra "is this active" guard
// needed here.
useViewportShortcuts()

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
      <!--
        The rail is gated on a ready document for the same reason
        ThumbnailPanel is: with no PDF open there is nothing for a tool to
        act on, and an enabled-looking rail over the drop zone invites
        clicks that cannot do anything.
      -->
      <ToolRail v-if="doc.isReady" />
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
      <Inspector v-if="doc.isReady" />
    </div>
  </div>
</template>
