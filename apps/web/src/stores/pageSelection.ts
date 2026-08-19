import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { PageId } from '@/stores/document'

/**
 * Which pages are selected in the page grid.
 *
 * VIEW STATE. Deliberately not in EditDocument: selecting a page is not an
 * edit, and putting it in history would make every click a Ctrl+Z step.
 *
 * A PINIA STORE rather than module-scope refs in a composable, which is
 * what this was first written as. Module state is shared by every consumer
 * for the lifetime of the PROCESS, which meant a selection survived opening
 * a different document -- and, in tests, leaked across files: a page-grid
 * suite left pages selected and the thumbnail-panel suite then found action
 * buttons where it expected a page count. A store is per-Pinia, so both
 * problems go away at the root instead of being cleared by hand.
 */
export const usePageSelectionStore = defineStore('pageSelection', () => {
  const selected = ref<PageId[]>([])
  /** Where a shift-click range starts from. */
  const anchor = ref<PageId | undefined>(undefined)

  function selectOnly(id: PageId): void {
    selected.value = [id]
    anchor.value = id
  }

  function toggle(id: PageId): void {
    selected.value = selected.value.includes(id)
      ? selected.value.filter((x) => x !== id)
      : [...selected.value, id]
    anchor.value = id
  }

  /** Inclusive range between the last anchor and `id`, in DISPLAY order. */
  function extendTo(id: PageId, order: PageId[]): void {
    const from = anchor.value ? order.indexOf(anchor.value) : -1
    const to = order.indexOf(id)
    if (from < 0 || to < 0) {
      selectOnly(id)
      return
    }
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    selected.value = order.slice(lo, hi + 1)
  }

  function clear(): void {
    selected.value = []
    anchor.value = undefined
  }

  /**
   * Drop ids that are no longer in the document. Called after a delete, so
   * the selection cannot go on naming pages that have gone.
   */
  function prune(order: PageId[]): void {
    const live = new Set(order)
    selected.value = selected.value.filter((id) => live.has(id))
    if (anchor.value && !live.has(anchor.value)) anchor.value = undefined
  }

  return {
    selected: computed(() => selected.value),
    count: computed(() => selected.value.length),
    isSelected: (id: PageId): boolean => selected.value.includes(id),
    selectOnly,
    toggle,
    extendTo,
    clear,
    prune,
  }
})
