<script setup lang="ts">
import { Minus, Plus, Maximize2, Scan } from 'lucide-vue-next'
import IconButton from '@/ui/IconButton.vue'
import Tooltip from '@/ui/Tooltip.vue'
import { useViewportStore } from '@/stores/viewport'

const vp = useViewportStore()
</script>

<template>
  <div
    class="pointer-events-auto flex items-center gap-0.5 rounded-full border border-border
           bg-surface-raised px-1 py-1 shadow-high"
  >
    <Tooltip content="Zoom out" shortcut="⌘−" side="top">
      <IconButton size="sm" label="Zoom out" @click="vp.zoomOut()"><Minus :size="15" :stroke-width="1.5" /></IconButton>
    </Tooltip>

    <button
      type="button"
      class="min-w-14 rounded-control px-1.5 py-1 text-center text-[13px] font-medium tabular-nums
             text-text transition-colors duration-fast hover:bg-surface-sunken"
      aria-label="Reset zoom to 100%"
      @click="vp.setFitMode('actual'); vp.setZoom(1)"
    >{{ vp.zoomPercent }}%</button>

    <Tooltip content="Zoom in" shortcut="⌘+" side="top">
      <IconButton size="sm" label="Zoom in" @click="vp.zoomIn()"><Plus :size="15" :stroke-width="1.5" /></IconButton>
    </Tooltip>

    <div class="mx-0.5 h-5 w-px bg-border" />

    <Tooltip content="Fit width" side="top">
      <IconButton size="sm" label="Fit width" :active="vp.fitMode === 'width'" @click="vp.setFitMode('width')">
        <Maximize2 :size="15" :stroke-width="1.5" class="rotate-45" />
      </IconButton>
    </Tooltip>

    <Tooltip content="Fit page" side="top">
      <IconButton size="sm" label="Fit page" :active="vp.fitMode === 'page'" @click="vp.setFitMode('page')">
        <Scan :size="15" :stroke-width="1.5" />
      </IconButton>
    </Tooltip>
  </div>
</template>
