<script setup lang="ts">
import { computed } from 'vue'
import Inspector from './Inspector.vue'
import { useEditsStore } from '@/stores/edits'

const edits = useEditsStore()

// The sheet is presence-driven rather than a toggle: on a phone there is no
// room for a permanently-docked panel, and a selection is exactly when its
// contents become meaningful. Dismissing it means clearing the selection,
// which is the same gesture as tapping empty page.
const open = computed(() => edits.selection.length > 0)
</script>

<template>
  <!--
    Wraps the SAME Inspector the desktop panel renders rather than
    duplicating field rendering, so a field added to inspectorFields.ts
    appears on both surfaces or neither.
  -->
  <div
    v-if="open"
    class="fixed inset-x-0 bottom-0 z-40 max-h-[50dvh] overflow-y-auto rounded-t-panel border-t
           border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-high"
    role="dialog"
    aria-modal="false"
    aria-label="Properties"
  >
    <header class="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
      <span class="text-[13px] font-medium">Properties</span>
      <button
        type="button"
        class="min-h-11 px-3 text-[13px] text-accent"
        @click="edits.clearSelection()"
      >Done</button>
    </header>
    <Inspector :back="false" class="w-full border-l-0" />
  </div>
</template>
