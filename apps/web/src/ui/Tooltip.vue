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
          class="z-50 rounded-control border border-border bg-surface-raised
                 text-[12px] text-text shadow-high select-none"
          :class="$slots.preview ? 'w-48 overflow-hidden' : 'px-2 py-1'"
        >
          <!--
            Optional picture and sentence above the name. Only a tooltip that
            is given one pays for it, and the content is mounted only while
            the tooltip is open, so a preview's animation runs only on hover.
          -->
          <div v-if="$slots.preview" class="border-b border-border bg-surface-sunken p-2">
            <slot name="preview" />
          </div>
          <div class="flex items-center gap-2" :class="$slots.preview ? 'px-2.5 pt-2' : ''">
            <span :class="$slots.preview ? 'font-medium' : ''">{{ props.content }}</span>
            <kbd
              v-if="props.shortcut"
              class="rounded-control border border-border bg-surface-sunken px-1 font-sans text-[11px] text-text-subtle"
            >{{ props.shortcut }}</kbd>
          </div>
          <p v-if="$slots.preview && $slots.hint" class="px-2.5 pb-2 pt-0.5 text-[11.5px] leading-snug text-text-muted">
            <slot name="hint" />
          </p>
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>
