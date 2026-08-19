import { ref, computed } from 'vue'
import type { PageId } from '@/stores/document'
import { useDragGesture } from '@/features/overlay/useDragGesture'

/**
 * `order` with `id` moved to `index`.
 *
 * The destination is computed against the order with `id` ALREADY REMOVED,
 * which is what makes "drop at position 2" mean the same thing whether the
 * page came from before or after that point. Computing it against the
 * original indices is the classic off-by-one in this feature, and it is
 * invisible in one direction and wrong in the other.
 *
 * Returns the original array when nothing moves, so a no-op drag does not
 * produce a history entry.
 */
export function moveTo(order: PageId[], id: PageId, index: number): PageId[] {
  const from = order.indexOf(id)
  if (from < 0) return order
  const without = order.filter((x) => x !== id)
  const at = Math.max(0, Math.min(index, without.length))
  const next = [...without.slice(0, at), id, ...without.slice(at)]
  return next.every((x, i) => x === order[i]) ? order : next
}

/**
 * Which gap the pointer is currently over, given each tile's vertical
 * midpoint. Tiles are laid out in a single column, so the y coordinate
 * alone decides.
 */
export function dropIndexFor(midpoints: number[], y: number): number {
  let i = 0
  while (i < midpoints.length && y > midpoints[i]!) i++
  return i
}

export type ReorderOptions = {
  order: () => PageId[]
  /** Vertical midpoint of each tile, in client coordinates, in display order. */
  midpoints: () => number[]
  commit: (next: PageId[]) => void
}

/**
 * Drag a page tile to a new position.
 *
 * Reuses useDragGesture rather than adding a second pointer implementation,
 * so pointer capture, the window-level listeners, and pointercancel all
 * behave exactly as they do for object drags.
 */
export function useDragReorder(opts: ReorderOptions) {
  const draggingId = ref<PageId | undefined>(undefined)
  const dropIndex = ref<number | undefined>(undefined)

  function onPointerDown(id: PageId, e: PointerEvent): void {
    const startY = e.clientY
    draggingId.value = id
    dropIndex.value = undefined

    const { onPointerDown: begin } = useDragGesture({
      onMove: ({ dy }) => {
        dropIndex.value = dropIndexFor(opts.midpoints(), startY + dy)
      },
      onEnd: () => {
        const id_ = draggingId.value
        const to = dropIndex.value
        draggingId.value = undefined
        dropIndex.value = undefined
        if (!id_ || to === undefined) return
        const order = opts.order()
        // dropIndexFor counts gaps in the list AS DISPLAYED, which still
        // contains the dragged tile; moveTo indexes the list with that tile
        // removed. Dragging DOWNWARD therefore lands one slot too far
        // unless the vacated slot is accounted for. Dragging upward needs no
        // adjustment, because the vacated slot is below the target.
        const from = order.indexOf(id_)
        const target = from >= 0 && to > from ? to - 1 : to
        const next = moveTo(order, id_, target)
        if (next !== order) opts.commit(next)
      },
    })
    begin(e)
  }

  return {
    draggingId: computed(() => draggingId.value),
    dropIndex: computed(() => dropIndex.value),
    onPointerDown,
  }
}
