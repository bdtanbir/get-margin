<script setup lang="ts">
import { useTheme } from '@/lib/theme'
import { useDocumentStore } from '@/stores/document'
import DropZone from '@/features/document/DropZone.vue'
const { resolved, cycle } = useTheme()
const doc = useDocumentStore()
</script>

<template>
  <!--
    Temporary wiring: DropZone (Task 15) was never mounted anywhere, and the
    real shell (PageList/DesktopShell/MobileShell) doesn't exist until Tasks
    17/20. This is the minimal placeholder needed for the drop zone to
    actually appear/disappear so Task 15a can prove the worker boundary
    end-to-end. Task 17 replaces this `v-else` branch with `PageList`.
  -->
  <DropZone v-if="doc.status !== 'ready'" />
  <div v-else class="h-dvh w-full flex flex-col items-center justify-center gap-4">
    <h1 class="text-2xl font-semibold tracking-tight">{{ doc.fileName }}</h1>
    <p class="text-sm text-text-muted">{{ doc.pageCount }} pages · Theme: {{ resolved }}</p>
    <button
      class="rounded-control border border-border bg-surface px-3 py-1.5 text-sm shadow-low
             transition-colors duration-fast hover:bg-surface-sunken"
      @click="cycle"
    >
      Cycle theme
    </button>
  </div>
</template>
