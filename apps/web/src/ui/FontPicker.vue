<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  ComboboxRoot, ComboboxAnchor, ComboboxTrigger, ComboboxPortal, ComboboxContent, ComboboxInput,
  ComboboxViewport, ComboboxItem, ComboboxItemIndicator, ComboboxEmpty,
} from 'reka-ui'
import { Check, ChevronDown, Search } from 'lucide-vue-next'
import { cssFamily, loadFont } from '@/lib/fonts'

/**
 * A searchable font select that draws every family in its own face, as
 * Google Docs' font menu does, so what a font looks like is visible before
 * it is chosen and a family is one keystroke away.
 *
 * Built on reka-ui's Combobox rather than a native <select>: an <option>
 * cannot be styled with a font on every platform, and this gets the keyboard
 * handling and ARIA of a listbox for free. The search box lives inside the
 * popup, over the list, so the closed control stays a plain button.
 *
 * Matching is done here (`ignore-filter`) on the label, so "times" finds
 * "Tinos (Times New Roman)" and "arial" finds "Arimo (Arial)" -- the names
 * people actually know these by, not only the open family behind them.
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

const search = ref('')

const shown = computed(() => {
  const q = search.value.trim().toLowerCase()
  return q ? props.options.filter((o) => o.label.toLowerCase().includes(q)) : props.options
})

const currentLabel = computed(
  () => props.options.find((o) => o.value === props.modelValue)?.label ?? props.modelValue,
)

function onOpen(open: boolean): void {
  search.value = ''
  if (!open) return
  for (const o of props.options) void loadFont(o.value).catch(() => {})
}
</script>

<template>
  <ComboboxRoot
    data-font-picker
    ignore-filter
    :model-value="props.modelValue"
    :disabled="props.disabled"
    :reset-search-term-on-select="false"
    :reset-search-term-on-blur="false"
    @update:model-value="(v: unknown) => v && emit('update:modelValue', String(v))"
    @update:open="onOpen"
  >
    <ComboboxAnchor as-child>
      <ComboboxTrigger
        :id="props.id"
        class="flex min-h-8 w-40 items-center justify-between gap-1 rounded-control border border-border
               bg-surface-sunken px-2 text-[13px] text-text disabled:opacity-50"
        :style="{ fontFamily: cssFamily(props.modelValue) }"
      >
        <span class="truncate">{{ currentLabel }}</span>
        <ChevronDown :size="14" :stroke-width="1.5" class="shrink-0 text-text-muted" />
      </ComboboxTrigger>
    </ComboboxAnchor>
    <ComboboxPortal>
      <ComboboxContent
        position="popper"
        :side-offset="4"
        align="end"
        class="z-50 flex max-h-[min(24rem,var(--reka-combobox-content-available-height))] min-w-56 flex-col
               overflow-hidden rounded-control border border-border bg-surface-raised shadow-high"
      >
        <div class="flex items-center gap-2 border-b border-border px-3">
          <Search :size="14" :stroke-width="1.5" class="shrink-0 text-text-muted" />
          <ComboboxInput
            v-model="search"
            data-font-search
            aria-label="Search fonts"
            placeholder="Search fonts"
            class="min-h-9 w-full bg-transparent text-[13px] text-text outline-none placeholder:text-text-subtle"
          />
        </div>
        <ComboboxViewport class="overflow-y-auto py-1">
          <ComboboxEmpty class="px-3 py-2 text-[13px] text-text-muted">No fonts match</ComboboxEmpty>
          <ComboboxItem
            v-for="o in shown"
            :key="o.value"
            :value="o.value"
            :data-font-option="o.value"
            class="relative flex min-h-9 cursor-pointer items-center py-1 pr-3 pl-8 text-[15px] text-text
                   outline-none data-[highlighted]:bg-surface-sunken"
            :style="{ fontFamily: cssFamily(o.value) }"
          >
            <ComboboxItemIndicator class="absolute left-2 inline-flex items-center">
              <Check :size="14" :stroke-width="1.5" />
            </ComboboxItemIndicator>
            <span>{{ o.label }}</span>
          </ComboboxItem>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>
