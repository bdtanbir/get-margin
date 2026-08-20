<script setup lang="ts">
import { computed, ref } from 'vue'
import { RotateCcw, RotateCw, Trash2, Scissors, Check } from 'lucide-vue-next'
import Thumbnail from '@/features/document/Thumbnail.vue'
import IconButton from '@/ui/IconButton.vue'
import { useDocumentStore, type PageId } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useViewportStore } from '@/stores/viewport'
import { usePageSelectionStore } from '@/stores/pageSelection'
import { useDragReorder } from './useDragReorder'
import SplitDialog from './SplitDialog.vue'
import AddSourceButton from './AddSourceButton.vue'

const doc = useDocumentStore()
const edits = useEditsStore()
const vp = useViewportStore()
const selection = usePageSelectionStore()

const emit = defineEmits<{ select: [index: number] }>()

const count = computed(() => selection.count)

/**
 * Toggle selection from the per-tile control.
 *
 * A SEPARATE affordance from tapping the thumbnail, which navigates. On the
 * phone the pages panel closes on navigation (deliberate Phase 1
 * behaviour, so tapping a page takes you to it rather than jumping the
 * viewport behind an open overlay) -- which made tap-to-select unreachable
 * there, because the grid carrying the actions was gone by the time a
 * selection existed. One control, both platforms: always visible on touch,
 * on hover or focus with a mouse.
 */
function toggleSelect(id: PageId, e: Event): void {
  e.stopPropagation()
  selection.toggle(id)
}

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

const listEl = ref<HTMLElement | null>(null)
const splitting = ref(false)

/**
 * Roving tabindex: one tile in the tab order, arrows move between them.
 *
 * The grid had NO keyboard support before this. It was a `role="listbox"`
 * whose options were not focusable, and the only way in was tabbing to the
 * buttons nested inside each tile -- which is the same nesting axe flags,
 * and one of those buttons did nothing when activated. Removing them
 * without this would have taken the grid from badly reachable to
 * unreachable.
 */
const focusIndex = ref(0)

function tileLabel(id: PageId, index: number): string {
  const from = merged.value ? `, from ${sourceName(id)}` : ''
  return `Page ${index + 1}${from}`
}

function focusTile(index: number): void {
  const clamped = Math.min(doc.pageOrder.length - 1, Math.max(0, index))
  focusIndex.value = clamped
  // Focus follows the roving index on the next frame, once the tabindex
  // attributes have been re-rendered.
  requestAnimationFrame(() => {
    const id = doc.pageOrder[clamped]
    if (!id) return
    listEl.value?.querySelector<HTMLElement>(`[data-page-tile="${id}"]`)?.focus()
  })
}

/**
 * Listbox keys.
 *
 * Arrows move without selecting, which is what a multi-select listbox
 * wants -- moving the focus should not destroy a selection the user has
 * built up. Space toggles the focused page, Enter navigates to it, and
 * Shift+Arrow extends, mirroring what shift-click already did with a
 * mouse.
 */
function onKeydown(id: PageId, index: number, e: KeyboardEvent): void {
  const last = doc.pageOrder.length - 1
  let next: number | null = null

  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = Math.min(last, index + 1)
      break
    case 'ArrowLeft':
    case 'ArrowUp':
      next = Math.max(0, index - 1)
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = last
      break
    case ' ':
    case 'Spacebar':
      e.preventDefault()
      selection.toggle(id)
      return
    case 'Enter':
      e.preventDefault()
      selection.selectOnly(id)
      vp.setAnchor(index)
      emit('select', index)
      return
    default:
      return
  }

  e.preventDefault()
  if (e.shiftKey) {
    const target = doc.pageOrder[next]
    if (target) selection.extendTo(target, doc.pageOrder)
  }
  focusTile(next)
}

/** More than one file open means the grid spans sources. */
const merged = computed(() => Object.keys(doc.sources).length > 1)

/** The file a page came from, for the per-source label and screen readers. */
function sourceName(id: string): string {
  const entry = edits.doc.pages[id]
  return (entry && doc.sources[entry.sourceId]?.name) || ''
}

/** True when this tile begins a run of pages from a different file. */
function startsSourceRun(index: number): boolean {
  if (!merged.value) return false
  const ids = doc.pageOrder
  const here = sourceName(ids[index]!)
  const previous = index > 0 ? sourceName(ids[index - 1]!) : ''
  return here !== previous
}

/**
 * Vertical midpoint of each tile, in client coordinates and in display
 * order. Read from the DOM at drag time rather than tracked reactively:
 * the layout is the authority on where the tiles actually are, and it
 * cannot go stale between the read and the drop.
 */
function midpoints(): number[] {
  const el = listEl.value
  if (!el) return []
  return [...el.querySelectorAll('[data-page-tile]')].map((tile) => {
    const box = tile.getBoundingClientRect()
    return box.top + box.height / 2
  })
}

// Destructured, not kept as an object: Vue unwraps refs that are top-level
// setup bindings, but NOT refs nested inside a returned object -- the
// template would compare a ComputedRef against a string and never match.
const { draggingId, dropIndex, onPointerDown: startReorder } = useDragReorder({
  order: () => doc.pageOrder,
  midpoints,
  // One op per completed drag, so a drag is one undo step.
  commit: (next) => edits.applyOp({ type: 'reorderPages', pageOrder: next }, 'Reorder pages'),
})

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
    <SplitDialog v-if="splitting" @close="splitting = false" />
    <header class="flex h-11 shrink-0 items-center gap-1 px-3 text-[13px] text-text-muted">
      <template v-if="count === 0">
        <span class="mr-auto">{{ doc.pageCount }} {{ doc.pageCount === 1 ? 'page' : 'pages' }}</span>
        <AddSourceButton />
        <IconButton size="sm" label="Split or extract" data-open-split @click="splitting = true">
          <Scissors :size="15" :stroke-width="1.5" />
        </IconButton>
      </template>
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

    <!--
      role=option is only meaningful inside a listbox; on its own it tells a
      screen reader an option exists but not what it belongs to or that the
      selection is multiple.
    -->
    <div
      ref="listEl"
      role="listbox"
      aria-label="Pages"
      aria-multiselectable="true"
      class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-3"
    >
      <p
        v-if="merged"
        data-merge-notice
        class="mb-2 rounded-control border border-border bg-surface-sunken p-2 text-[12px] text-text-muted"
      >
        Merging keeps each page exactly as it is. Bookmarks and page labels from
        the added file are not carried over.
      </p>

      <template v-for="(id, i) in doc.pageOrder" :key="id">
        <!--
          A header wherever the run of pages from one file gives way to
          another, so a merged grid reads as the documents it came from
          rather than one undifferentiated stack.
        -->
        <p
          v-if="startsSourceRun(i)"
          data-source-header
          class="px-1 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-text-subtle"
        >{{ sourceName(id) }}</p>

      <div
        :data-page-tile="id"
        role="option"
        :aria-selected="selection.isSelected(id) ? 'true' : 'false'"
        :aria-grabbed="draggingId === id ? 'true' : undefined"
        :aria-label="tileLabel(id, i)"
        :aria-current="vp.anchorIndex === i ? 'true' : undefined"
        :tabindex="i === focusIndex ? 0 : -1"
        class="group relative rounded-control focus-visible:outline-2 focus-visible:outline-offset-2
               focus-visible:outline-focus"
        :class="[
          selection.isSelected(id) ? 'ring-2 ring-accent' : '',
          draggingId === id ? 'opacity-40' : '',
        ]"
        @click="(e) => onClick(id, i, e)"
        @focus="focusIndex = i"
        @keydown="(e) => onKeydown(id, i, e)"
        @pointerdown="(e) => startReorder(id, e)"
      >
        <!--
          Selection affordance for pointers, and deliberately NOT a button.

          The tile is a `role="option"`, and axe's nested-interactive is
          explicit that a negative tabindex inside an interactive control
          "does not prevent assistive technologies from focusing the
          element (even with aria-hidden=true)" -- so a <button
          tabindex="-1" aria-hidden> here still violated the rule. A span
          is not focusable at all, which is the only version that actually
          resolves it.

          Nothing is lost: the option carries the selection semantics
          (`aria-selected`), its own name, and Space to toggle. This is the
          mouse shortcut that adds to a selection without replacing it.

          `pointerdown.stop` as well as `click.stop` because the tile also
          starts a reorder drag on pointerdown, and without it every tap
          here would begin dragging the page it is trying to select.
        -->
        <span
          :data-select-page="id"
          aria-hidden="true"
          class="absolute left-1 top-1 z-10 flex size-6 cursor-pointer items-center justify-center rounded-control
                 border border-border bg-surface/90 opacity-0 transition-opacity
                 focus-visible:opacity-100 group-hover:opacity-100
                 [@media(hover:none)]:opacity-100"
          :class="selection.isSelected(id) ? 'opacity-100 bg-accent text-accent-fg' : ''"
          @click.stop="(e) => toggleSelect(id, e)"
          @pointerdown.stop
        >
          <Check v-if="selection.isSelected(id)" :size="14" :stroke-width="2" />
        </span>

        <!--
          An insertion marker rather than animating the tiles apart: the
          marker says exactly where the page will land, and animation during
          a drag competes with the drag itself for frames.
        -->
        <div
          v-if="dropIndex === i"
          data-drop-marker
          class="pointer-events-none absolute inset-x-1 -top-0.5 h-0.5 rounded bg-accent"
        />
        <!--
          `interactive: false`: the tile is the option, so the thumbnail
          must not be a control inside it. Its handler here was already a
          no-op -- the tile's own click did the work -- so this removes a
          focusable element that did nothing when activated.
        -->
        <Thumbnail
          :page="doc.pages[id]!"
          :index="i"
          :active="vp.anchorIndex === i"
          :interactive="false"
        />
        <span v-if="merged" class="sr-only">from {{ sourceName(id) }}</span>
      </div>
      </template>
      <!-- The gap after the last tile, so a page can be dropped at the end. -->
      <div
        v-if="dropIndex === doc.pageOrder.length"
        data-drop-marker
        class="pointer-events-none mx-1 h-0.5 rounded bg-accent"
      />
    </div>
  </div>
</template>
