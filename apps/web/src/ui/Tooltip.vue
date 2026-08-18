<script setup lang="ts">
import { TooltipRoot, TooltipTrigger, TooltipPortal, TooltipContent, TooltipProvider } from 'reka-ui'

const props = withDefaults(defineProps<{
  content: string
  shortcut?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
}>(), { side: 'right' })
</script>

<template>
  <TooltipProvider :delay-duration="400">
    <TooltipRoot>
      <TooltipTrigger as-child><slot /></TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          :side="props.side"
          :side-offset="6"
          class="z-50 flex items-center gap-2 rounded-control border border-border bg-surface-raised
                 px-2 py-1 text-[12px] text-text shadow-high select-none"
        >
          <span>{{ props.content }}</span>
          <kbd
            v-if="props.shortcut"
            class="rounded-control border border-border bg-surface-sunken px-1 font-sans text-[11px] text-text-subtle"
          >{{ props.shortcut }}</kbd>
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>
