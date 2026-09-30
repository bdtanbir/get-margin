<script setup lang="ts">
import {
  SelectRoot, SelectTrigger, SelectValue, SelectPortal, SelectContent, SelectViewport,
  SelectItem, SelectItemText, SelectItemIndicator,
} from 'reka-ui'
import { Check, ChevronDown } from 'lucide-vue-next'
import { cssFamily, loadFont } from '@/lib/fonts'

/**
 * A font select that draws every family in its own face, as Google Docs'
 * font menu does, so what a font looks like is visible before it is chosen.
 *
 * Built on reka-ui's Select rather than a native <select>: an <option> cannot
 * be styled with a font on every platform, and this gets the keyboard
 * handling, typeahead and ARIA of a listbox for free.
 *
 * The faces are registered when the menu OPENS, not at startup: it is one
 * regular file per family, and a document that never opens the picker should
 * not pay for them. Until a file arrives an item shows in the family's
 * generic fallback and re-renders by itself when the face is added.
 */
const props = defineProps<{
  id?: string
  modelValue: string
  options: Array<{ value: string; label: string }>
  disabled?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [family: string] }>()

function onOpen(open: boolean): void {
  if (!open) return
  for (const o of props.options) void loadFont(o.value).catch(() => {})
}
</script>

<template>
  <SelectRoot
    data-font-picker
    :model-value="props.modelValue"
    :disabled="props.disabled"
    @update:model-value="(v) => emit('update:modelValue', String(v))"
    @update:open="onOpen"
  >
    <SelectTrigger
      :id="props.id"
      class="flex min-h-8 w-40 items-center justify-between gap-1 rounded-control border border-border
             bg-surface-sunken px-2 text-[13px] text-text disabled:opacity-50"
      :style="{ fontFamily: cssFamily(props.modelValue) }"
    >
      <SelectValue class="truncate" />
      <ChevronDown :size="14" :stroke-width="1.5" class="shrink-0 text-text-muted" />
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        position="popper"
        :side-offset="4"
        class="z-50 max-h-[min(24rem,var(--reka-select-content-available-height))] min-w-56 overflow-hidden
               rounded-control border border-border bg-surface-raised shadow-high"
      >
        <SelectViewport class="max-h-[inherit] overflow-y-auto py-1">
          <SelectItem
            v-for="o in props.options"
            :key="o.value"
            :value="o.value"
            :data-font-option="o.value"
            class="flex min-h-9 cursor-pointer items-center gap-2 py-1 pr-3 pl-8 text-[15px] text-text
                   outline-none data-[highlighted]:bg-surface-sunken"
            :style="{ fontFamily: cssFamily(o.value) }"
          >
            <SelectItemIndicator class="absolute left-2 inline-flex items-center">
              <Check :size="14" :stroke-width="1.5" />
            </SelectItemIndicator>
            <SelectItemText>{{ o.label }}</SelectItemText>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
