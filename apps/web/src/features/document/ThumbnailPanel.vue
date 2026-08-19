<script setup lang="ts">
import PageGrid from '@/features/pages/PageGrid.vue'
import { useDocumentStore } from '@/stores/document'
import { useViewportStore } from '@/stores/viewport'

const doc = useDocumentStore()
const vp = useViewportStore()

const emit = defineEmits<{ select: [index: number] }>()

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
//
// Also emits `select` after moving the anchor. On desktop ThumbnailPanel is
// a permanent sidebar, so nothing needs to react to the emit — but on phone
// (MobileShell) it is rendered inside a full-screen `fixed inset-0` modal,
// and without this the user taps a thumbnail, the viewport jumps behind the
// still-open opaque overlay, and nothing visibly happens. Emitting the event
// keeps the decision of what it MEANS in the shell, not here: MobileShell
// closes its modal on it, DesktopShell ignores it — no feature component
// branches on which shell it's mounted under.
function select(index: number): void {
  vp.setAnchor(index)
  emit('select', index)
}
</script>

<template>
  <aside
    class="flex h-full w-60 shrink-0 flex-col border-r border-border bg-surface"
    aria-label="Pages"
  >
    <!--
      Task 46: the grid owns the page count, the selection, and the page
      actions. This panel is now just the sidebar frame around it.
    -->
    <PageGrid @select="select" />
  </aside>
</template>
