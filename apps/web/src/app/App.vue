<script setup lang="ts">
import { useDocumentStore } from '@/stores/document'
import DropZone from '@/features/document/DropZone.vue'
import PageList from '@/features/viewport/PageList.vue'
import ZoomPill from '@/features/viewport/ZoomPill.vue'

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
    The wrapping <template> groups PageList + the pill as one v-else branch
    without introducing an extra DOM node.
  -->
  <DropZone v-if="doc.status !== 'ready'" />
  <template v-else>
    <PageList />
    <div class="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center">
      <ZoomPill />
    </div>
  </template>
</template>
