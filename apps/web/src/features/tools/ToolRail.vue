<script setup lang="ts">
import IconButton from '@/ui/IconButton.vue'
import Tooltip from '@/ui/Tooltip.vue'
import { useToolsStore } from '@/stores/tools'
import { TOOLS } from './toolList'

const tools = useToolsStore()
</script>

<template>
  <nav
    class="flex w-16 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border bg-surface py-2"
    aria-label="Tools"
  >
    <Tooltip v-for="t in TOOLS" :key="t.id" :content="t.label" side="right">
      <!--
        aria-pressed is left to IconButton, which derives it from `active`.
        Setting it here as well would make it a fallthrough attribute that
        overrides IconButton's own binding -- one control with two owners of
        the same attribute is how the two get to disagree.
      -->
      <IconButton
        size="sm"
        :label="t.label"
        :active="tools.active === t.id"
        @click="tools.setTool(t.id)"
      >
        <component :is="t.icon" :size="18" :stroke-width="1.5" />
      </IconButton>
    </Tooltip>
  </nav>
</template>
