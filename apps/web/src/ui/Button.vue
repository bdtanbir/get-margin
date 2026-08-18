<script setup lang="ts">
import { computed } from 'vue'
import { cva } from 'class-variance-authority'
import { cn } from './cn'
import Spinner from './Spinner.vue'

const props = withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  disabled?: boolean
  loading?: boolean
}>(), { variant: 'secondary', size: 'md', disabled: false, loading: false })

const emit = defineEmits<{ click: [MouseEvent] }>()

const button = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-control font-medium ' +
  'transition-colors duration-fast whitespace-nowrap ' +
  'disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-fg hover:bg-accent-hover shadow-low',
        secondary: 'bg-surface text-text border border-border hover:bg-surface-sunken shadow-low',
        ghost: 'bg-transparent text-text-muted hover:bg-surface-sunken hover:text-text',
        danger: 'bg-danger text-white hover:opacity-90 shadow-low',
      },
      size: { sm: 'h-8 px-2.5 text-[13px]', md: 'h-9 px-3.5 text-sm' },
    },
  },
)

const isBlocked = computed(() => props.disabled || props.loading)

function onClick(e: MouseEvent): void {
  if (isBlocked.value) return
  emit('click', e)
}
</script>

<template>
  <button
    type="button"
    :class="cn(button({ variant: props.variant, size: props.size }))"
    :disabled="isBlocked"
    :aria-busy="props.loading ? 'true' : undefined"
    @click="onClick"
  >
    <Spinner v-if="props.loading" class="size-3.5" />
    <slot />
  </button>
</template>
