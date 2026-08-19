import { nanoid } from 'nanoid'
import { viewToPdf, rectFromPoints, directedRect, type Rect } from '@margin/transform'
import type { ShapeObject, EditObject } from '@margin/pdf-core'
import type { PageState } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore, type ToolId } from '@/stores/tools'
import { useDragGesture } from './useDragGesture'

/**
 * Below this, a drag is a stray click. Committing it would leave an
 * invisible zero-size object on the page that the user cannot see to select
 * and therefore cannot delete.
 */
const MIN_DRAG_PT = 3

/** Kinds this composable knows how to create. Tasks 30-35 extend it. */
const DRAWABLE = ['rect', 'ellipse', 'line', 'arrow'] as const
export type DrawableTool = (typeof DRAWABLE)[number]

export function isDrawable(tool: ToolId): tool is DrawableTool {
  return (DRAWABLE as readonly string[]).includes(tool)
}

/** A line or arrow keeps its direction; anything with an interior does not. */
const isDirected = (kind: DrawableTool): boolean => kind === 'line' || kind === 'arrow'

export const SHAPE_DEFAULTS = {
  stroke: [0, 0, 0] as [number, number, number],
  strokeWidth: 2,
  fill: null,
}

function significant(rect: Rect, kind: DrawableTool): boolean {
  if (isDirected(kind)) return Math.hypot(rect.w, rect.h) >= MIN_DRAG_PT
  return rect.w >= MIN_DRAG_PT || rect.h >= MIN_DRAG_PT
}

/**
 * Drag-to-draw for the shape tools.
 *
 * `page` and `zoom` are getters rather than values because the overlay
 * re-renders around a live gesture -- reading them at call time keeps a
 * mid-drag zoom change from being computed against a stale scale.
 *
 * All coordinate conversion goes through @margin/transform; the only
 * arithmetic here is subtracting the surface's own client origin, which is
 * DOM geometry rather than a coordinate-space conversion.
 */
export function useDrawTool(page: () => PageState, zoom: () => number) {
  const edits = useEditsStore()
  const tools = useToolsStore()

  function onPointerDown(e: PointerEvent): void {
    const tool = tools.active
    if (!isDrawable(tool)) return
    const surface = e.currentTarget as HTMLElement | null
    if (!surface) return

    const box = surface.getBoundingClientRect()
    const originX = e.clientX - box.left
    const originY = e.clientY - box.top
    const start = viewToPdf({ x: originX, y: originY }, page().geometry, zoom())
    let rect: Rect = isDirected(tool) ? directedRect(start, start) : rectFromPoints(start, start)

    const { onPointerDown: begin } = useDragGesture({
      onMove: ({ dx, dy }) => {
        const end = viewToPdf({ x: originX + dx, y: originY + dy }, page().geometry, zoom())
        rect = isDirected(tool) ? directedRect(start, end) : rectFromPoints(start, end)
        // Draft lives in the tools store, never in edit history: a half-drawn
        // rectangle is not an undoable step.
        tools.setDraft({ pageId: page().id, rect })
      },
      onEnd: () => {
        tools.clearDraft()
        if (!significant(rect, tool)) return
        const object: ShapeObject = {
          ...SHAPE_DEFAULTS,
          id: nanoid(10),
          pageId: page().id,
          kind: tool,
          rect,
          rotation: 0,
          z: edits.nextZ(),
          locked: false,
          opacity: 1,
        }
        edits.applyOp({ type: 'addObject', object: object as EditObject }, 'Draw')
        // Hand the new object straight to the select tool: the thing you
        // just drew is the thing you want to adjust.
        tools.setTool('select')
        edits.select([object.id])
      },
    })
    begin(e)
  }

  return { onPointerDown }
}
