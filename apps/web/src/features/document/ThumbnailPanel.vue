<script setup lang="ts">
import Thumbnail from './Thumbnail.vue'
import { useDocumentStore } from '@/stores/document'
import { useViewportStore } from '@/stores/viewport'

const doc = useDocumentStore()
const vp = useViewportStore()

// `PageList` is virtualized: a thumbnail's target page may not exist in the
// DOM at all yet (only pages near the current scroll position are mounted),
// so a `document.querySelector('[data-page-index=...]')?.scrollIntoView()`
// approach silently no-ops for any page outside the currently rendered
// window — clicking thumbnail 8 while looking at page 1 would move nothing.
// `vp.setAnchor` alone is the correct single source of truth here: PageList
// watches `vp.anchorIndex` and calls the virtualizer's own `scrollToIndex`
// (which works regardless of what is currently mounted) whenever it
// changes, so ThumbnailPanel never needs to touch the scroller's DOM
// itself.
function select(index: number): void {
  vp.setAnchor(index)
}
</script>

<template>
  <aside
    class="flex h-full w-60 shrink-0 flex-col border-r border-border bg-surface"
    aria-label="Pages"
  >
    <header class="flex h-11 shrink-0 items-center px-3 text-[13px] font-medium text-text-muted">
      {{ doc.pageCount }} {{ doc.pageCount === 1 ? 'page' : 'pages' }}
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-3">
      <Thumbnail
        v-for="(id, i) in doc.pageOrder"
        :key="id"
        :page="doc.pages[id]!"
        :index="i"
        :active="vp.anchorIndex === i"
        @select="select"
      />
    </div>
  </aside>
</template>
