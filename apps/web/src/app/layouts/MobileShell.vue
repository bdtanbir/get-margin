<script setup lang="ts">
import { ref } from 'vue'
import { LayoutGrid } from 'lucide-vue-next'
import TopBar from '../TopBar.vue'
import PageList from '@/features/viewport/PageList.vue'
import ZoomPill from '@/features/viewport/ZoomPill.vue'
import ThumbnailPanel from '@/features/document/ThumbnailPanel.vue'
import IconButton from '@/ui/IconButton.vue'
import { useDocumentStore } from '@/stores/document'

const doc = useDocumentStore()
const pagesOpen = ref(false)

// Amendment A2: no ResizeObserver/applyFit wiring here — see the identical
// comment in DesktopShell.vue. PageList owns its own resize-driven refit;
// this shell only needs to give it a properly sized ancestor.
</script>

<template>
  <div class="flex h-dvh flex-col">
    <TopBar compact />
    <!--
      Amendment A3: p-3 pb-16 gives the workspace (and PageList, which
      fills it, per the Task 20 PageList.vue change) an inset, biased
      toward the bottom where ZoomPill actually floats (`bottom-3` below).
      Same derivation as DesktopShell.vue: fit.ts's own 32px reserve + this
      bottom padding must cover the pill's own footprint from this
      element's edge (`bottom-3` = 12px + its ~42px rendered height = 54px,
      so bottom padding >= 22px); `pb-16` (64px) clears that with real
      margin to spare — verified empirically with a `p-3`-only version
      that produced a measurable overlap in a real browser at a 390px-wide
      viewport before landing here.
    -->
    <main class="relative min-h-0 flex-1 overflow-hidden p-3 pb-16">
      <PageList />
      <div class="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
        <ZoomPill />
      </div>
    </main>

    <!-- Phase 2 replaces this with the scrollable tool strip + bottom sheet. -->
    <nav
      v-if="doc.isReady"
      class="flex h-14 shrink-0 items-center justify-around border-t border-border bg-surface
             pb-[env(safe-area-inset-bottom)]"
      aria-label="Document actions"
    >
      <IconButton label="Pages" :active="pagesOpen" @click="pagesOpen = true">
        <LayoutGrid :size="19" :stroke-width="1.5" />
      </IconButton>
    </nav>

    <!-- Pages become a full-screen modal on phones, per spec §6. -->
    <div
      v-if="pagesOpen"
      class="fixed inset-0 z-40 flex flex-col bg-surface"
      role="dialog"
      aria-modal="true"
      aria-label="Pages"
    >
      <header class="flex h-14 shrink-0 items-center justify-between border-b border-border px-3">
        <span class="text-[13px] font-medium">Pages</span>
        <button type="button" class="min-h-11 px-3 text-[13px] text-accent" @click="pagesOpen = false">Done</button>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <ThumbnailPanel class="!w-full !border-r-0" />
      </div>
    </div>
  </div>
</template>
