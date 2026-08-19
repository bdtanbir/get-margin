<script setup lang="ts">
import { computed } from 'vue'
import { pdfRectToView, viewRectToPdf } from '@margin/transform'
import type { PageState } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useDragGesture } from './useDragGesture'

const props = defineProps<{ page: PageState; zoom: number }>()
const edits = useEditsStore()

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

const selected = computed(() => {
  const id = edits.selection[0]
  const o = id ? edits.doc.objects[id] : undefined
  return o && o.pageId === props.page.id ? o : undefined
})

/**
 * The selection box in view space. All conversion goes through
 * @margin/transform -- this component performs no coordinate arithmetic of
 * its own (spec 1.4's standing rule).
 */
const box = computed(() => {
  const o = selected.value
  return o ? pdfRectToView(o.rect, props.page.geometry, props.zoom) : undefined
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
function gesture(label: string, onMove: (d: { dx: number; dy: number }) => void, e: PointerEvent): void {
  edits.beginTransaction(label)
  const { onPointerDown } = useDragGesture({
    onMove,
    onEnd: () => edits.endTransaction(),
  })
  onPointerDown(e)
}

function startMove(e: PointerEvent): void {
  const o = selected.value
  const start = box.value
  if (!o || !start || o.locked) return
  gesture('Move', ({ dx, dy }) => commit({ ...start, x: start.x + dx, y: start.y + dy }), e)
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
  -->
  <div
    v-if="selected && box"
    data-selection
    class="pointer-events-auto absolute cursor-move ring-2 ring-accent"
    :style="style"
    @pointerdown.stop="startMove"
  >
    <template v-if="!selected.locked">
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
