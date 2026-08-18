<script setup lang="ts">
import { useDocumentStore } from '@/stores/document'
import DropZone from '@/features/document/DropZone.vue'
import PageList from '@/features/viewport/PageList.vue'

const doc = useDocumentStore()
</script>

<template>
  <!--
    Task 17 replaces the single-PageCanvas scaffolding (Task 16 A3) with the
    real virtualized viewer: PageList (backed by the render-priority queue
    and the viewport store) once the document is ready, DropZone otherwise.
  -->
  <DropZone v-if="doc.status !== 'ready'" />
  <PageList v-else class="h-dvh w-full" />
</template>
