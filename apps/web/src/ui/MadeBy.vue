<script setup lang="ts">
import { computed } from 'vue'
import { Coffee } from 'lucide-vue-next'
import { AUTHOR_NAME, AUTHOR_URL, SUPPORT_URL, supportAvailable } from '@/lib/author'

/**
 * The credit line, and an optional way to buy the author a coffee.
 *
 * Both links open in a new tab. That is not a stylistic choice: this app
 * holds the user's document and their unexported edits in memory, and
 * navigating the tab away from it would throw that work on the floor to
 * show someone a homepage. `rel` is set because `target="_blank"` without
 * it hands the opened page a `window.opener` reference.
 *
 * The coffee button renders only when `SUPPORT_URL` is set, so the default
 * build shows a credit and nothing else -- no button that goes nowhere.
 */
const props = withDefaults(defineProps<{ align?: 'center' | 'start' }>(), { align: 'center' })

/**
 * A prop rather than a `class` passed in from outside: the caller would
 * have to override `justify-center`, and two conflicting Tailwind
 * utilities on one element resolve by stylesheet order rather than by the
 * order they were written, so the override would work or not depending on
 * which utility Tailwind happened to emit first.
 */
const justify = computed(() => (props.align === 'start' ? 'justify-start' : 'justify-center'))

const canSupport = supportAvailable()
</script>

<template>
  <p
    data-made-by
    class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-text-subtle"
    :class="justify"
  >
    <span>
      Made by
      <a
        data-author-link
        :href="AUTHOR_URL"
        target="_blank"
        rel="noopener noreferrer"
        class="text-accent underline underline-offset-2 hover:text-accent-hover"
      >{{ AUTHOR_NAME }}</a>
    </span>

    <template v-if="canSupport">
      <span aria-hidden="true">·</span>
      <a
        data-support-link
        :href="SUPPORT_URL"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1 text-accent underline underline-offset-2 hover:text-accent-hover"
      >
        <Coffee :size="13" :stroke-width="1.5" aria-hidden="true" />
        Buy me a coffee
      </a>
    </template>
  </p>
</template>
