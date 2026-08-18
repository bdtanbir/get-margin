<script setup lang="ts">
import { useDocumentStore } from '@/stores/document'
import DropZone from '@/features/document/DropZone.vue'
import PageList from '@/features/viewport/PageList.vue'
import ZoomPill from '@/features/viewport/ZoomPill.vue'
import ThumbnailPanel from '@/features/document/ThumbnailPanel.vue'

const doc = useDocumentStore()
</script>

<template>
  <!--
    Task 17 replaces the single-PageCanvas scaffolding (Task 16 A3) with the
    real virtualized viewer: PageList (backed by the render-priority queue
    and the viewport store) once the document is ready, DropZone otherwise.

    Task 18: ZoomPill is mounted here, alongside PageList, rather than
    inside it — it is floating chrome over the viewer, not part of the
    scroller, and this is the app's actual root so there is no risk of it
    shipping unmounted (a fully-built DropZone once shipped that way with a
    green suite; naming the mounting parent is the standing rule since).

    Task 19: ThumbnailPanel is mounted here too, as a sibling of the
    PageList/ZoomPill column, for the same reason — this is the app's real
    root, so there is no way for it to be built but never rendered. The
    outer flex row gives the panel a fixed-width column and lets the page
    column take the rest; ZoomPill moves from `fixed` (viewport-relative) to
    `absolute` inside that column so it stays centred over the pages, not
    over the whole window including the new sidebar.
  -->
  <DropZone v-if="doc.status !== 'ready'" />
  <div v-else class="flex h-dvh w-full">
    <ThumbnailPanel />
    <div class="relative min-w-0 flex-1">
      <PageList />
      <div class="pointer-events-none absolute inset-x-0 bottom-4 z-40 flex justify-center">
        <ZoomPill />
      </div>
    </div>
  </div>
</template>
