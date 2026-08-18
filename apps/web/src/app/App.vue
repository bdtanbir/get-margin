<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useTheme } from '@/lib/theme'
import { useDocumentStore } from '@/stores/document'
import DropZone from '@/features/document/DropZone.vue'
import PageCanvas from '@/features/viewport/PageCanvas.vue'
import { getPdfClient } from '@/workers/pdfClient'
import type { RenderResult } from '@/workers/pdfService'

const { resolved, cycle } = useTheme()
const doc = useDocumentStore()

// Task 16 (A3): PageCanvas's only real consumer is PageList (Task 17), which
// doesn't exist yet. Render page 0 directly here so a real browser run can
// prove the bitmap cache/canvas pipeline actually paints pixels, rather than
// shipping a component nothing renders. Not the viewer — Task 17 replaces
// this block with PageList.
const firstPage = computed(() => doc.pages[doc.pageOrder[0] ?? ''])
const bitmap = ref<RenderResult | undefined>(undefined)

watch(
  () => doc.isReady,
  async (ready) => {
    bitmap.value = undefined
    if (!ready) return
    bitmap.value = (await getPdfClient().render(0, devicePixelRatio)) ?? undefined
  },
  { immediate: true },
)
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
  <div v-else class="h-dvh w-full overflow-auto flex flex-col items-center gap-4 p-6">
    <h1 class="text-2xl font-semibold tracking-tight">{{ doc.fileName }}</h1>
    <p class="text-sm text-text-muted">{{ doc.pageCount }} pages · Theme: {{ resolved }}</p>
    <button
      class="rounded-control border border-border bg-surface px-3 py-1.5 text-sm shadow-low
             transition-colors duration-fast hover:bg-surface-sunken"
      @click="cycle"
    >
      Cycle theme
    </button>
    <PageCanvas v-if="firstPage" :page="firstPage" :zoom="1" :bitmap="bitmap" />
  </div>
</template>
