<script setup lang="ts">
import { useTheme } from '@/lib/theme'
const { resolved, cycle } = useTheme()
</script>

<template>
  <div class="h-dvh w-full flex flex-col items-center justify-center gap-4">
    <h1 class="text-2xl font-semibold tracking-tight">get-margin</h1>
    <p class="text-sm text-text-muted">Theme: {{ resolved }}</p>
    <button
      class="rounded-control border border-border bg-surface px-3 py-1.5 text-sm shadow-low
             transition-colors duration-fast hover:bg-surface-sunken"
      @click="cycle"
    >
      Cycle theme
    </button>
  </div>
</template>
