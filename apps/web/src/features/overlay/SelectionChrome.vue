<script setup lang="ts">
import { computed } from 'vue'
import { viewRectToPdf, viewDeltaToPage } from '@margin/transform'
import type { ImagePatchObject, PageQuadIndex, TextPatchObject } from '@margin/pdf-core'
import type { PageState } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { useDocumentStore } from '@/stores/document'
import { ASCENT_RATIO } from '@/lib/fonts'
import { useDragGesture } from './useDragGesture'
import { pageBoxes, pageAtPoint } from './pageBoxes'
import { objectViewRect } from './objectViewRect'
import { alignmentRails } from './alignmentRails'
import { snapOffset } from './snapOffset'

/**
 * `index` is the page's quad index, when it has been fetched. Only the
 * patch drag uses it, and only to build alignment rails -- everything else
 * here works without it, which is why it is optional rather than something
 * the drag waits for.
 */
const props = defineProps<{ page: PageState; zoom: number; index?: PageQuadIndex | undefined }>()
const edits = useEditsStore()
const tools = useToolsStore()
const doc = useDocumentStore()

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
type Handle = (typeof HANDLES)[number]

/**
 * How far above the box the rotate handle sits, in CSS pixels. Bound into
 * the style below rather than expressed as a Tailwind `-top-*` class,
 * because startRotate() needs the same number to know where the pointer
 * started relative to the box centre -- two sources of truth for this offset
 * is a rotation that is silently off by a few degrees.
 */
const ROTATE_OFFSET_PX = 24

/**
 * How near a rail a dragged line has to come before it is pulled onto it,
 * in CSS PIXELS.
 *
 * View pixels rather than points so the reach feels identical at every
 * zoom. It also means the threshold shrinks to almost nothing when zoomed
 * far in, which is the behaviour you want: someone working at 800% is
 * placing something precisely and does not want to be nudged.
 */
const SNAP_PX = 6

const selected = computed(() => {
  const id = edits.selection[0]
  const o = id ? edits.doc.objects[id] : undefined
  return o && o.pageId === props.page.id ? o : undefined
})

/**
 * Reopen a text object for editing.
 *
 * `ObjectLayer` already has a `dblclick` that does exactly this, and it
 * could never fire once the object was selected: the box below covers the
 * object with `pointer-events-auto` and stops the pointer on the way down,
 * so every gesture landed here instead. Moving worked -- that is what this
 * box is for -- while editing looked broken, which is precisely what was
 * reported: "added text i can't change but i can move".
 *
 * The surface that owns the pointer has to own the gesture.
 */
function editText(): void {
  const o = selected.value
  if (o && o.kind === 'text' && !o.locked) tools.startEditing(o.id)
}

/**
 * The selection box in view space. All conversion goes through
 * @margin/transform -- this component performs no coordinate arithmetic of
 * its own (spec 1.4's standing rule).
 */
const box = computed(() => {
  const o = selected.value
  return o ? objectViewRect(o, props.page.geometry, props.zoom) : undefined
})

const style = computed(() => {
  const b = box.value
  if (!b) return {}
  return { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` }
})

/** Resize anchors: which view-space edges a handle moves. */
const EDGES: Record<Handle, { l: number; t: number; r: number; b: number }> = {
  nw: { l: 1, t: 1, r: 0, b: 0 }, n: { l: 0, t: 1, r: 0, b: 0 },
  ne: { l: 0, t: 1, r: 1, b: 0 }, e: { l: 0, t: 0, r: 1, b: 0 },
  se: { l: 0, t: 0, r: 1, b: 1 }, s: { l: 0, t: 0, r: 0, b: 1 },
  sw: { l: 1, t: 0, r: 0, b: 1 }, w: { l: 1, t: 0, r: 0, b: 0 },
}

const MIN_SIZE_PT = 4

function commit(viewRect: { x: number; y: number; w: number; h: number }): void {
  const o = selected.value
  if (!o) return
  const rect = viewRectToPdf(viewRect, props.page.geometry, props.zoom)
  edits.applyOp({ type: 'updateObject', id: o.id, patch: { rect } }, 'Move')
}

/**
 * One transaction per gesture. Without this a single drag is 60 undo steps
 * -- the exact failure transactions exist to prevent (spec 1.2). applyOp
 * still fires on every frame so the overlay tracks the pointer live; only
 * HISTORY is coalesced.
 *
 * begin/end rather than withTransaction: the callback form is synchronous
 * and would close the transaction the moment the move listeners were
 * registered, before a single drag frame had been applied.
 */
function gesture(
  label: string,
  onMove: (d: { dx: number; dy: number }) => void,
  e: PointerEvent,
  onEnd?: () => void,
): void {
  edits.beginTransaction(label)
  const { onPointerDown } = useDragGesture({
    onMove,
    onEnd: () => {
      edits.endTransaction()
      // Runs on pointercancel as well as pointerup -- see useDragGesture --
      // so nothing a gesture raised can outlive the gesture.
      onEnd?.()
    },
  })
  onPointerDown(e)
}

/**
 * Drag an object, across pages if that is where it is dropped.
 *
 * A move used to be page-local: the rect grew past the sheet's edge while
 * the object stayed OWNED by the page it started on, so it was clipped at
 * that page's boundary and could never reach the next one -- the object was
 * effectively trapped on page one.
 *
 * So the gesture works in CLIENT space, and the page under the pointer
 * decides the owner on every frame. The boxes are read once at the start:
 * the pages do not move while a drag is in progress, and re-measuring every
 * frame would force layout sixty times a second.
 *
 * `origin`, `start` and the deltas stay relative to the page the drag BEGAN
 * on even after the object changes hands, so a drag that crosses two pages
 * is as exact as one that crosses none.
 */
function startMove(e: PointerEvent): void {
  const o = selected.value
  const start = box.value
  if (!o || !start || o.locked) return
  if (o.kind === 'textPatch') return startMovePatch(e, o)
  if (o.kind === 'imagePatch') return startMoveImagePatch(e, o)
  const boxes = pageBoxes()
  const origin = boxes.find((b) => b.id === props.page.id)
  const id = o.id
  // The page the object is on right now -- which the drag itself changes.
  let owner = props.page.id

  gesture('Move', ({ dx, dy }) => {
    const view = { ...start, x: start.x + dx, y: start.y + dy }
    // Nothing measured (a page not laid out yet, or a unit test): fall back
    // to the page-local move rather than inventing a drop target.
    if (!origin) return commit(view)

    const drop = pageAtPoint(e.clientX + dx, e.clientY + dy, boxes)
      ?? boxes.find((b) => b.id === owner)
    const geometry = drop ? doc.pages[drop.id]?.geometry : undefined
    if (!drop || !geometry) return commit(view)

    // Client space is the common ground between two pages: the box's
    // top-left, wherever it is on screen, expressed in the drop page's own
    // view coordinates.
    const local = {
      x: view.x + origin.left - drop.left,
      y: view.y + origin.top - drop.top,
      w: view.w,
      h: view.h,
    }
    const rect = viewRectToPdf(local, geometry, props.zoom)
    const patch = drop.id === owner ? { rect } : { pageId: drop.id, rect }
    owner = drop.id
    edits.applyOp({ type: 'updateObject', id, patch }, 'Move')
  }, e)
}

/**
 * Drag an EDITED LINE, which moves differently from everything else.
 *
 * Two departures from `startMove`, and both are forced:
 *
 * The rect is not rewritten. A patch's rect is the line it REPLACES; the
 * cover is drawn from it, and the cover has to stay where the document's
 * own glyphs are or they reappear from underneath the replacement. So the
 * drag accumulates into `offset`, which moves the text alone.
 *
 * It cannot change pages. A patch is addressed by (pageId, lineIndex) into
 * one page's extraction and guarded by a hash of that line's text; dropped
 * on another page it would point at a line that hashes differently and the
 * export would refuse the whole document rather than mispatch it. So this
 * never consults `pageBoxes`.
 *
 * The offset is read at the START of the gesture, not per frame: the drag
 * reports deltas from where it began, and adding them to a value this same
 * drag is rewriting would compound it.
 */
function startMovePatch(e: PointerEvent, o: TextPatchObject): void {
  const from = { dx: o.offset?.dx ?? 0, dy: o.offset?.dy ?? 0 }
  const id = o.id
  const rect = { ...o.rect }
  /**
   * The line's own baseline, or the same approximation the renderer falls
   * back to for patches stored before it was recorded. Snapping has to aim
   * at the number the user can SEE, and that is whichever of the two the
   * overlay drew with.
   */
  const baseline = o.baseline ?? o.rect.y + o.rect.h * ASCENT_RATIO
  /**
   * Built once, at the start of the gesture. The rails are the page's
   * layout, which does not change while a pointer is down, and rebuilding
   * them per frame would walk every line on the page sixty times a second.
   *
   * The moving line's own rails are excluded: it cannot be aligned to
   * itself, and its rails would sit exactly where it started -- a snap
   * target that only ever means "put it back".
   */
  const rails = props.index
    ? alignmentRails(props.index, { exclude: o.lineIndex })
    : { xs: [], ys: [] }

  // Raises the alignment rails, which are feedback for THIS gesture and
  // come back down with it.
  tools.startMovingPatch(id)
  gesture('Move', ({ dx, dy }) => {
    // Page space is top-down like the screen, so no sign flips -- the only
    // conversion is out of CSS pixels. That is the writer's job to invert.
    const d = viewDeltaToPage({ x: dx, y: dy }, props.page.geometry, props.zoom)
    const offset = snapOffset({
      rect,
      baseline,
      offset: { dx: from.dx + d.x, dy: from.dy + d.y },
      rails,
      // The reach is a screen distance; the rails are points.
      tolerance: SNAP_PX / props.zoom,
    })
    edits.applyOp({ type: 'updateObject', id, patch: { offset } }, 'Move')
  }, e, () => tools.stopMovingPatch())
}

/**
 * Drag a MOVED IMAGE, which moves the way an edited line does.
 *
 * The rect is not rewritten, for the same reason `startMovePatch` does not
 * rewrite one: an image patch's rect is the image it REPLACES, the cover is
 * drawn from it, and the cover has to stay over the document's own image or
 * that image reappears from underneath the copy. So the drag accumulates
 * into `offset`.
 *
 * It cannot change pages either. The patch is addressed by (pageId,
 * imageIndex) into one page's device walk and guarded by a hash of that
 * placement; dropped on another page it would address a different image, or
 * none.
 *
 * NO ALIGNMENT RAILS. The rails are built from the page's text lines, and
 * they exist because a moved line wants to sit level with other lines. An
 * image has no baseline to align and is rarely the width of a column, so
 * snapping it to a text rail would fight the user rather than help them.
 */
function startMoveImagePatch(e: PointerEvent, o: ImagePatchObject): void {
  const from = { dx: o.offset?.dx ?? 0, dy: o.offset?.dy ?? 0 }
  const id = o.id

  gesture('Move image', ({ dx, dy }) => {
    // Page space is top-down like the screen, so no sign flips -- the only
    // conversion is out of CSS pixels. Inverting it is the writer's job.
    const d = viewDeltaToPage({ x: dx, y: dy }, props.page.geometry, props.zoom)
    edits.applyOp(
      { type: 'updateObject', id, patch: { offset: { dx: from.dx + d.x, dy: from.dy + d.y } } },
      'Move image',
    )
  }, e)
}

function startResize(e: PointerEvent, handle: Handle): void {
  const o = selected.value
  const start = box.value
  if (!o || !start || o.locked) return
  const edge = EDGES[handle]
  gesture('Resize', ({ dx, dy }) => {
    const x = start.x + edge.l * dx
    const y = start.y + edge.t * dy
    const w = Math.max(MIN_SIZE_PT * props.zoom, start.w + edge.r * dx - edge.l * dx)
    const h = Math.max(MIN_SIZE_PT * props.zoom, start.h + edge.b * dy - edge.t * dy)
    commit({ x, y, w, h })
  }, e)
}

/** Fold into 0..360 so a few full turns of the handle stay bounded. */
const norm = (deg: number): number => ((deg % 360) + 360) % 360

function startRotate(e: PointerEvent): void {
  const o = selected.value
  const start = box.value
  if (!o || !start || o.locked) return
  const base = o.rotation

  // The handle sits at the box's top centre, so the pointer starts directly
  // above the centre by half the height plus the handle's offset. That
  // vector is what the drag rotates ABOUT the centre -- the angle of the
  // delta alone carries no information about where the gesture began.
  const r0 = start.h / 2 + ROTATE_OFFSET_PX
  const a0 = Math.atan2(-r0, 0)

  gesture('Rotate', ({ dx, dy }) => {
    // View space is y-DOWN, so a growing atan2 is a clockwise sweep on
    // screen. PDF rotation is counterclockwise-positive (the overlay's root
    // <g> carries a y-flip), hence the negation.
    const a1 = Math.atan2(-r0 + dy, dx)
    const deg = ((a1 - a0) * 180) / Math.PI
    edits.applyOp(
      { type: 'updateObject', id: o.id, patch: { rotation: norm(Math.round(base - deg)) } },
      'Rotate',
    )
  }, e)
}
</script>

<template>
  <!--
    Layer 3: DOM, not SVG, deliberately (spec 1.3). Tailwind classes, focus
    management, and mobile virtual keyboards all behave normally here and do
    not inside an <svg>.

    `touch-none` for the reason PageOverlay's draw surface carries it: a
    drag that starts here MOVES the object, and the scroller above would
    otherwise be entitled to read it as a pan. The handles are children, so
    the ancestor intersection covers resize and rotate too. This box is
    only as large as the selected object, so scrolling by dragging anywhere
    else on the page is unaffected.
  -->
  <div
    v-if="selected && box"
    data-selection
    class="pointer-events-auto absolute cursor-move touch-none ring-2 ring-accent"
    :style="style"
    @pointerdown.stop="startMove"
    @dblclick.stop="editText"
  >
    <!--
      Neither patch kind has either handle. An edited line's box is the
      line's, not a size of its own, and the writer sits the replacement on
      that line's baseline whatever `rotation` says. A moved image is drawn
      at the size of the image it replaces, from a raster captured at that
      size. In both cases the controls would offer an edit that silently
      does nothing.
    -->
    <template
      v-if="!selected.locked && selected.kind !== 'textPatch' && selected.kind !== 'imagePatch'"
    >
      <button
        v-for="h in HANDLES"
        :key="h"
        :data-handle="h"
        type="button"
        :aria-label="`Resize ${h}`"
        class="absolute size-2.5 rounded-full border border-accent bg-surface"
        :class="{
          'left-0 -translate-x-1/2': h.includes('w'),
          'right-0 translate-x-1/2': h.includes('e'),
          'left-1/2 -translate-x-1/2': h === 'n' || h === 's',
          'top-0 -translate-y-1/2': h.includes('n'),
          'bottom-0 translate-y-1/2': h.includes('s'),
          'top-1/2 -translate-y-1/2': h === 'e' || h === 'w',
        }"
        @pointerdown.stop="(e) => startResize(e, h)"
      />
      <button
        data-rotate-handle
        type="button"
        aria-label="Rotate"
        class="absolute left-1/2 size-2.5 -translate-x-1/2 rounded-full border border-accent bg-surface"
        :style="{ top: `${-ROTATE_OFFSET_PX}px` }"
        @pointerdown.stop="startRotate"
      />
    </template>
  </div>
</template>
