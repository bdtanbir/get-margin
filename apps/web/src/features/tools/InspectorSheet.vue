<script setup lang="ts">
import { computed, watch } from 'vue'
import Inspector from './Inspector.vue'
import { useEditsStore } from '@/stores/edits'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const edits = useEditsStore()

/**
 * ASKED FOR, not inferred from the selection.
 *
 * This sheet used to open on `selection.length > 0` alone, which meant it
 * slid up over the document after every single shape drawn -- and again
 * the moment a finger landed on an object to move it, because objects
 * select on pointerdown. On a phone that is a panel covering half the page
 * in response to a gesture that was not about properties at all.
 *
 * The selection is still a precondition: there is nothing to describe
 * without one. It is no longer the trigger.
 */
const visible = computed(() => props.open && edits.selection.length > 0)

/**
 * Tell the owner when the selection disappears out from under an open
 * sheet -- deleted, undone, or dismissed by a tap on empty page.
 *
 * Load-bearing rather than tidy: the owner holds the open flag, and a flag
 * left true after the selection went away would spring the sheet open by
 * itself on the next object drawn, which is exactly the behaviour being
 * removed here.
 */
watch(
  () => edits.selection.length,
  (n) => {
    if (n === 0 && props.open) emit('close')
  },
)
</script>

<template>
  <!--
    Wraps the SAME Inspector the desktop panel renders rather than
    duplicating field rendering, so a field added to inspectorFields.ts
    appears on both surfaces or neither.
  -->
  <div
    v-if="visible"
    data-inspector-sheet
    class="fixed inset-x-0 bottom-0 z-40 max-h-[50dvh] overflow-y-auto rounded-t-panel border-t
           border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-high"
    role="dialog"
    aria-modal="false"
    aria-label="Properties"
  >
    <header class="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
      <span class="text-[13px] font-medium">Properties</span>
      <!--
        Dismisses the PANEL, not the selection. The object stays selected so
        it can still be dragged, nudged or deleted the moment the sheet is
        out of the way; clearing a selection is what tapping empty page is
        for. Previously this cleared the selection, because that was the
        only way to close a sheet the selection itself was holding open.
      -->
      <button
        type="button"
        data-inspector-done
        class="min-h-11 px-3 text-[13px] text-accent"
        @click="emit('close')"
      >Done</button>
    </header>
    <Inspector :back="false" class="w-full border-l-0" />
  </div>
</template>
