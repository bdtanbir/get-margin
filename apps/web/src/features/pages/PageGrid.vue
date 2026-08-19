<script setup lang="ts">
import { computed } from 'vue'
import { RotateCcw, RotateCw, Trash2 } from 'lucide-vue-next'
import Thumbnail from '@/features/document/Thumbnail.vue'
import IconButton from '@/ui/IconButton.vue'
import { useDocumentStore, type PageId } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useViewportStore } from '@/stores/viewport'
import { usePageSelectionStore } from '@/stores/pageSelection'

const doc = useDocumentStore()
const edits = useEditsStore()
const vp = useViewportStore()
const selection = usePageSelectionStore()

const emit = defineEmits<{ select: [index: number] }>()

const count = computed(() => selection.count)

function onClick(id: PageId, index: number, e: MouseEvent): void {
  if (e.shiftKey) selection.extendTo(id, doc.pageOrder)
  else if (e.ctrlKey || e.metaKey) selection.toggle(id)
  else {
    selection.selectOnly(id)
    // A plain click is still a navigation, as it was in Phase 1.
    vp.setAnchor(index)
    emit('select', index)
  }
}

function rotate(by: 90 | 270): void {
  const ids = [...selection.selected]
  if (ids.length === 0) return
  // One transaction: rotating four pages is ONE action to the user, so it
  // is one Ctrl+Z. The loop is synchronous, so withTransaction is correct
  // here and begin/end is not needed.
  edits.withTransaction(ids.length === 1 ? 'Rotate page' : 'Rotate pages', () => {
    for (const id of ids) edits.applyOp({ type: 'rotatePage', pageId: id, by }, 'Rotate')
  })
  // Crop and rotate are the ONLY edits that change what MuPDF renders, so
  // unlike every Phase 2 op they must drop the cached bitmap.
  for (const id of ids) vp.invalidate(id)
}

function remove(): void {
  const ids = [...selection.selected]
  if (ids.length === 0) return
  edits.applyOp({ type: 'deletePages', pageIds: ids }, 'Delete pages')
  selection.prune(doc.pageOrder)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="flex h-11 shrink-0 items-center gap-1 px-3 text-[13px] text-text-muted">
      <span v-if="count === 0">{{ doc.pageCount }} {{ doc.pageCount === 1 ? 'page' : 'pages' }}</span>
      <template v-else>
        <span class="mr-auto">{{ count }} selected</span>
        <IconButton size="sm" label="Rotate left" data-rotate-left @click="rotate(270)">
          <RotateCcw :size="15" :stroke-width="1.5" />
        </IconButton>
        <IconButton size="sm" label="Rotate right" data-rotate-right @click="rotate(90)">
          <RotateCw :size="15" :stroke-width="1.5" />
        </IconButton>
        <IconButton size="sm" label="Delete pages" data-delete-pages @click="remove">
          <Trash2 :size="15" :stroke-width="1.5" />
        </IconButton>
      </template>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-3">
      <div
        v-for="(id, i) in doc.pageOrder"
        :key="id"
        :data-page-tile="id"
        role="option"
        :aria-selected="selection.isSelected(id) ? 'true' : 'false'"
        class="rounded-control"
        :class="selection.isSelected(id) ? 'ring-2 ring-accent' : ''"
        @click="(e) => onClick(id, i, e)"
      >
        <Thumbnail
          :page="doc.pages[id]!"
          :index="i"
          :active="vp.anchorIndex === i"
          @select="() => {}"
        />
      </div>
    </div>
  </div>
</template>
