<script setup lang="ts">
import IconButton from '@/ui/IconButton.vue'
import { useToolsStore } from '@/stores/tools'
import { TOOLS } from './toolList'

const tools = useToolsStore()
</script>

<template>
  <!--
    The mobile counterpart of ToolRail, reading the same TOOLS list. No
    Tooltip wrapper: a hover tooltip has no trigger on touch, and the
    accessible name IconButton already carries is what a screen reader
    announces either way.
  -->
  <nav
    class="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border bg-surface px-2 py-1.5"
    aria-label="Tools"
  >
    <IconButton
      v-for="t in TOOLS"
      :key="t.id"
      size="sm"
      :label="t.label"
      :active="tools.active === t.id"
      @click="tools.setTool(t.id)"
    >
      <component :is="t.icon" :size="18" :stroke-width="1.5" />
    </IconButton>
  </nav>
</template>
