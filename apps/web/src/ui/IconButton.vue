<script setup lang="ts">
import { cva } from 'class-variance-authority'
import { cn } from './cn'

const props = withDefaults(defineProps<{
  /** Required: this control has no visible text, so it has no accessible name without one. */
  label: string
  size?: 'sm' | 'md'
  active?: boolean | undefined
  disabled?: boolean
}>(), { size: 'md', disabled: false, active: undefined })

const emit = defineEmits<{ click: [MouseEvent] }>()

const btn = cva(
  'inline-flex items-center justify-center rounded-control transition-colors duration-fast ' +
  'disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      // min-h-11 / min-w-11 = 44px, the spec's touch-target floor.
      size: { sm: 'size-8 min-h-8 min-w-8', md: 'size-11 min-h-11 min-w-11' },
      active: {
        true: 'bg-accent text-accent-fg',
        false: 'text-text-muted hover:bg-surface-sunken hover:text-text',
      },
    },
    defaultVariants: { active: false },
  },
)
</script>

<template>
  <button
    type="button"
    :class="cn(btn({ size: props.size, active: !!props.active }))"
    :aria-label="props.label"
    :aria-pressed="props.active === undefined ? undefined : (props.active ? 'true' : 'false')"
    :disabled="props.disabled"
    @click="emit('click', $event)"
  >
    <slot />
  </button>
</template>
