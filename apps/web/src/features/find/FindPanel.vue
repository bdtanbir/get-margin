<script setup lang="ts">
import { ref, watch, onMounted, nextTick } from 'vue'
import { ChevronUp, ChevronDown, X } from 'lucide-vue-next'
import IconButton from '@/ui/IconButton.vue'
import { useFindStore } from '@/stores/find'
import { useViewportStore } from '@/stores/viewport'
import { useDocumentStore } from '@/stores/document'

const emit = defineEmits<{ close: [] }>()

const find = useFindStore()
const vp = useViewportStore()
const doc = useDocumentStore()

/**
 * Where a match's page sits in the document AS DISPLAYED.
 *
 * The worker searches the source document, so a match carries a SOURCE
 * page index. The viewport anchors on display position, and the two
 * diverge the moment a page is reordered, deleted, or a second file merged
 * in -- so jumping straight to `match.page` would scroll somewhere the
 * match is not. Returns -1 when the page carrying the match has been
 * deleted, which is a real state and not an error.
 */
function displayIndexOf(sourceIndex: number): number {
  return doc.pageOrder.findIndex((id) => doc.pages[id]?.sourceIndex === sourceIndex)
}
const input = ref<HTMLInputElement | null>(null)

onMounted(async () => {
  await nextTick()
  input.value?.focus()
  input.value?.select()
})

/**
 * Debounced, because every keystroke would otherwise scan the whole
 * document. The store discards stale responses on its own, so this is
 * about work rather than correctness.
 */
let timer: ReturnType<typeof setTimeout> | undefined
watch(
  () => [find.query, find.caseSensitive, find.wholeWord],
  () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void find.search(), 180)
  },
)

// Following the current match is the whole point of next/previous.
watch(() => find.active, (match) => {
  if (!match) return
  const index = displayIndexOf(match.page)
  if (index >= 0) vp.setAnchor(index)
})

function close(): void {
  find.clear()
  emit('close')
}
</script>

<template>
  <!--
    A panel rather than a dialog: search is something you do WHILE reading,
    so a modal that covers the document would hide the thing being
    searched.
  -->
  <div
    data-find-panel
    role="search"
    aria-label="Find in document"
    class="pointer-events-auto absolute right-4 top-3 z-40 flex items-center gap-1
           rounded-panel border border-border bg-surface-raised p-1.5 shadow-high"
  >
    <input
      ref="input"
      v-model="find.query"
      type="search"
      placeholder="Find"
      data-find-input
      aria-label="Find"
      class="min-h-8 w-48 rounded-control border border-border bg-surface-sunken px-2 text-[13px]"
      @keydown.enter.prevent="find.next()"
      @keydown.shift.enter.prevent="find.previous()"
      @keydown.esc.prevent="close()"
    >

    <!--
      The count is the answer to the question being asked, so it sits next
      to the box rather than somewhere the eye has to hunt for.
    -->
    <span data-find-count class="min-w-16 px-1 text-[12px] text-text-muted" role="status">
      <template v-if="find.searching">Searching…</template>
      <template v-else-if="find.query === ''" />
      <template v-else-if="find.count === 0">No matches</template>
      <template v-else>
        {{ find.current + 1 }} of {{ find.count }}<span v-if="find.capped">+</span>
      </template>
    </span>

    <IconButton size="sm" label="Previous match" data-find-prev
                :disabled="find.count === 0" @click="find.previous()">
      <ChevronUp :size="15" :stroke-width="1.5" />
    </IconButton>
    <IconButton size="sm" label="Next match" data-find-next
                :disabled="find.count === 0" @click="find.next()">
      <ChevronDown :size="15" :stroke-width="1.5" />
    </IconButton>

    <label class="flex items-center gap-1 px-1 text-[12px] text-text-muted">
      <input v-model="find.caseSensitive" type="checkbox" data-find-case class="accent-accent">
      Aa
    </label>
    <label class="flex items-center gap-1 px-1 text-[12px] text-text-muted">
      <input v-model="find.wholeWord" type="checkbox" data-find-whole class="accent-accent">
      Word
    </label>

    <IconButton size="sm" label="Close find" data-find-close @click="close()">
      <X :size="15" :stroke-width="1.5" />
    </IconButton>
  </div>
</template>
