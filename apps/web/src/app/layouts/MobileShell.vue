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
      Amendment A3 (Task 21, supersedes the Task 20 version of this
      comment): on a ~390px phone with portrait pages, fit-page is
      width-bound — several pages stack in view at once, so a floating
      pill positioned with `absolute`/`bottom-*` sits over the CURRENTLY
      VISIBLE page content regardless of how much bottom padding the
      scroll container gets, because padding only pushes the fit-computed
      page smaller/higher — it never removes the pill from the pages'
      shared visual layer. Task 20 tried exactly that (`pb-16`, even a
      deliberately larger `pb-64` per its own notes) and still observed a
      measurable overlap with a real fitted page's bottom edge in a real
      browser at a 390px-wide viewport, because the pill floats over
      WHATEVER is scrolled into that screen region, not just the last
      page's trailing edge.
      The actual fix: stop floating the pill over the scroll area at all.
      It now lives inside the bottom `nav` below, in normal flex flow
      alongside the "Pages" button — that nav is `shrink-0`, so `main`
      (which fills the remaining space via `flex-1`) is measured SMALLER
      by the nav's real height. The scroll area is the only thing that
      shrinks; nothing floats over it. `p-3` here is now just an ordinary,
      symmetric inset — no bottom-bias reserve needed, because there is no
      longer anything floating in from that edge.
    -->
    <main class="relative min-h-0 flex-1 overflow-hidden p-3">
      <PageList />
    </main>

    <!--
      Phase 2 replaces this with the scrollable tool strip + bottom sheet.
      ZoomPill moved in here (Amendment A3) specifically because this is
      the shell's one region that already reduces PageList's box via
      ordinary layout (`shrink-0` sibling of a `flex-1` main) rather than
      floating over it — exactly the "reserved space in the layout flow"
      the amendment calls for.
    -->
    <nav
      v-if="doc.isReady"
      class="flex h-14 shrink-0 items-center justify-between gap-2 border-t border-border
             bg-surface px-3 pb-[env(safe-area-inset-bottom)]"
      aria-label="Document actions"
    >
      <ZoomPill />
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
