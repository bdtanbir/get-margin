import { nanoid } from 'nanoid'
import { viewToPdf, rectFromPoints, directedRect, type Rect } from '@margin/transform'
import type {
  ShapeObject, WhiteoutObject, TextObject, LinkObject, FieldObject, EditObject,
} from '@margin/pdf-core'
import type { PageState } from '@/stores/document'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore, type ToolId } from '@/stores/tools'
import { DEFAULT_FAMILY } from '@/lib/fonts'
import { normalizeUri } from '@/lib/linkUrl'
import { useDragGesture } from './useDragGesture'
import { newFieldNames } from '@/features/forms/fieldNaming'

/**
 * Below this, a drag is a stray click. Committing it would leave an
 * invisible zero-size object on the page that the user cannot see to select
 * and therefore cannot delete.
 */
const MIN_DRAG_PT = 3

/** Kinds this composable knows how to create. Task 35 extends it. */
const DRAWABLE = ['rect', 'ellipse', 'line', 'arrow', 'whiteout', 'text', 'link', 'field'] as const
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

/** Opaque white, the only default that makes the tool's name true on sight. */
export const WHITEOUT_DEFAULTS = { fill: [1, 1, 1] as [number, number, number] }

export const TEXT_DEFAULTS = {
  text: '',
  fontFamily: DEFAULT_FAMILY,
  fontSize: 14,
  color: [0, 0, 0] as [number, number, number],
  align: 'left' as const,
}

/** Minimum box a dragged-out text frame gets, so an empty one is still visible. */
const TEXT_MIN_SIZE_PT = { w: 120, h: 20 }

/**
 * A link needs a URL before it can exist, and the URL is validated at
 * op-creation time so an invalid one is unrepresentable (spec 2.1). The
 * prompt is injectable so tests do not depend on window.prompt, and so a
 * later task can swap it for a proper dialog without touching this file.
 */
export type UriPrompt = (current: string) => string | null

const defaultPrompt: UriPrompt = (current) =>
  typeof window === 'undefined' ? null : window.prompt('Link URL', current)

let askForUri: UriPrompt = defaultPrompt

export function setUriPrompt(fn: UriPrompt | undefined): void {
  askForUri = fn ?? defaultPrompt
}

/**
 * The kind-specific half of a newly drawn object. Whiteout carries a `fill`
 * and no stroke; the four shapes carry stroke and fill. Splitting it here
 * keeps the gesture code below identical for every drawable kind.
 */
/**
 * A new field's properties, minus the naming -- which depends on what is
 * already in the document and so is decided at commit time.
 */
export const FIELD_DEFAULTS = {
  value: '' as string,
  options: [] as string[],
  required: false,
  readOnly: false,
  multiline: false,
  maxLength: null as number | null,
  // 0 means auto-size, which is what a /DA of "0 Tf" asks for -- the right
  // default for a box whose height the user chose by dragging.
  fontSize: 0,
}

export function draftDefaults(kind: ToolId) {
  if (kind === 'whiteout') return WHITEOUT_DEFAULTS
  if (kind === 'text') return TEXT_DEFAULTS
  if (kind === 'link') return { uri: '' }
  if (kind === 'field') return FIELD_DEFAULTS
  return SHAPE_DEFAULTS
}

/** A field small enough to be an accident still needs to be usable. */
const FIELD_MIN_SIZE_PT = { w: 60, h: 16 }
const BUTTON_SIZE_PT = 16

function significant(rect: Rect, kind: DrawableTool): boolean {
  // Text is the exception: a single click is a legitimate way to place a
  // caret, so it gets a default-sized box rather than being discarded.
  // A field behaves the same way -- clicking where a field should go is a
  // reasonable way to ask for one.
  if (kind === 'text' || kind === 'field') return true
  if (isDirected(kind)) return Math.hypot(rect.w, rect.h) >= MIN_DRAG_PT
  return rect.w >= MIN_DRAG_PT || rect.h >= MIN_DRAG_PT
}

/**
 * A clicked (rather than dragged) frame gets a usable default size.
 *
 * Buttons are SQUARE regardless of the drag, because a checkbox is square
 * in every viewer that renders one and a stretched box would render its
 * appearance stream distorted -- the two-state dot is drawn to the widget's
 * own BBox.
 */
function sizeFor(rect: Rect, kind: DrawableTool, buttonish = false): Rect {
  if (kind === 'field' && buttonish) {
    const s = BUTTON_SIZE_PT
    return { x: rect.x, y: rect.y + rect.h - s, w: s, h: s }
  }
  const min = kind === 'text' ? TEXT_MIN_SIZE_PT : kind === 'field' ? FIELD_MIN_SIZE_PT : null
  if (!min) return rect
  const w = Math.max(rect.w, min.w)
  const h = Math.max(rect.h, min.h)
  // The box's y is its BOTTOM edge, so growing it must extend downward from
  // the click, not upward -- otherwise a click places a box above the cursor.
  return { x: rect.x, y: rect.y + rect.h - h, w, h }
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
  const doc = useDocumentStore()

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
        // The URL is asked for and validated BEFORE the object exists, so a
        // rejected or cancelled link leaves nothing behind to clean up.
        let uri = ''
        if (tool === 'link') {
          const answer = askForUri('')
          if (answer === null) return
          try {
            uri = normalizeUri(answer)
          } catch (e) {
            doc.error = e instanceof Error ? e.message : 'That link is not valid.'
            return
          }
        }

        // A field's name depends on what is already in the document, and a
        // radio button's group and export value on which buttons exist --
        // so naming happens here, at commit time, not in draftDefaults.
        const type = tools.fieldType
        const buttonish = tool === 'field' && (type === 'checkbox' || type === 'radio')
        const fieldParts = tool === 'field'
          ? { fieldType: type, ...newFieldNames(edits.doc.objects, type) }
          : {}

        const object = {
          ...draftDefaults(tool),
          ...(tool === 'link' ? { uri } : {}),
          ...fieldParts,
          id: nanoid(10),
          pageId: page().id,
          kind: tool,
          rect: sizeFor(rect, tool, buttonish),
          rotation: 0,
          z: edits.nextZ(),
          locked: false,
          opacity: 1,
        } as ShapeObject | WhiteoutObject | TextObject | LinkObject | FieldObject
        edits.applyOp(
          { type: 'addObject', object: object as EditObject },
          tool === 'field' ? 'Add form field' : 'Draw',
        )
        // Hand the new object straight to the select tool: the thing you
        // just drew is the thing you want to adjust.
        tools.setTool('select')
        edits.select([object.id])
        // A new text frame is empty, so drop the caret straight into it --
        // requiring a second click to start typing is a dead end the user
        // has no reason to expect.
        if (tool === 'text') tools.startEditing(object.id)
      },
    })
    begin(e)
  }

  return { onPointerDown }
}
