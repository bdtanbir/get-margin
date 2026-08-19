<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'
import { nanoid } from 'nanoid'
import { viewToPdf } from '@margin/transform'
import type { InkObject, EditObject } from '@margin/pdf-core'
import type { PageState } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { rgb } from './objects/svgPaint'

const props = defineProps<{ page: PageState; zoom: number }>()
const edits = useEditsStore()
const tools = useToolsStore()

/** Not exported: `<script setup>` has no export slot, and nothing else needs it. */
const INK_DEFAULTS: { color: [number, number, number]; strokeWidth: number } =
  { color: [0.1, 0.1, 0.9], strokeWidth: 2 }

/** A stroke shorter than this in view pixels is a tap, not a mark. */
const MIN_STROKE_PX = 2

const surface = ref<HTMLCanvasElement | null>(null)

/**
 * The in-flight stroke, as a PLAIN ARRAY held outside Vue's reactivity.
 *
 * This is the load-bearing decision of this component. A pointermove stream
 * is hundreds of points per second; pushing each into reactive state (let
 * alone into the Pinia store) re-runs every dependent computed and re-renders
 * the overlay per point, which is what makes naive freehand implementations
 * unusable. Nothing here is reactive until pointerup commits ONE object.
 */
let points: number[] = []
let drawing = false
let box: DOMRect | undefined

function ctx2d(): CanvasRenderingContext2D | null {
  return surface.value?.getContext('2d') ?? null
}

/** Size the backing store to the element, so strokes are not blurry. */
function resize(): void {
  const el = surface.value
  if (!el) return
  const dpr = window.devicePixelRatio || 1
  const rect = el.getBoundingClientRect()
  el.width = Math.max(1, Math.round(rect.width * dpr))
  el.height = Math.max(1, Math.round(rect.height * dpr))
  const c = ctx2d()
  if (c) c.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function paint(): void {
  const c = ctx2d()
  const el = surface.value
  if (!c || !el) return
  const dpr = window.devicePixelRatio || 1
  c.clearRect(0, 0, el.width / dpr, el.height / dpr)
  if (points.length < 4) return
  c.strokeStyle = rgb(INK_DEFAULTS.color)
  c.lineWidth = INK_DEFAULTS.strokeWidth * props.zoom
  c.lineCap = 'round'
  c.lineJoin = 'round'
  c.beginPath()
  c.moveTo(points[0]!, points[1]!)
  for (let i = 2; i + 1 < points.length; i += 2) c.lineTo(points[i]!, points[i + 1]!)
  c.stroke()
}

function onPointerDown(e: PointerEvent): void {
  const el = surface.value
  if (!el) return
  resize()
  box = el.getBoundingClientRect()
  drawing = true
  points = [e.clientX - box.left, e.clientY - box.top]
  el.setPointerCapture?.(e.pointerId)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
}

function onMove(e: PointerEvent): void {
  if (!drawing || !box) return
  points.push(e.clientX - box.left, e.clientY - box.top)
  paint()
}

function reset(): void {
  drawing = false
  points = []
  box = undefined
  paint()
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('pointercancel', onCancel)
}

/**
 * pointercancel is NOT pointerup. The browser fires it when the gesture was
 * taken away -- palm rejection, a system edge-swipe, the pointer being
 * captured elsewhere -- so the stroke was never finished and committing the
 * fragment would leave a mark the user did not draw and did not release.
 * Abandon it.
 */
function onCancel(): void {
  reset()
}

function onUp(): void {
  if (!drawing) return
  const captured = points
  reset()
  if (captured.length < 4) return

  // Converted to PDF space ONCE, at commit time -- doing it per pointermove
  // would run the transform hundreds of times for a result that is thrown
  // away on every frame but the last.
  const stroke: number[] = []
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i + 1 < captured.length; i += 2) {
    const p = viewToPdf({ x: captured[i]!, y: captured[i + 1]! }, props.page.geometry, props.zoom)
    stroke.push(p.x, p.y)
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  if (maxX - minX < MIN_STROKE_PX / props.zoom && maxY - minY < MIN_STROKE_PX / props.zoom) return

  const pad = INK_DEFAULTS.strokeWidth
  const object: InkObject = {
    id: nanoid(10),
    pageId: props.page.id,
    kind: 'ink',
    strokes: [stroke],
    color: INK_DEFAULTS.color,
    strokeWidth: INK_DEFAULTS.strokeWidth,
    // Selection geometry only: the exported Ink annotation derives its own
    // box from the points (see write/objects/ink.ts).
    rect: { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 },
    rotation: 0,
    z: edits.nextZ(),
    locked: false,
    opacity: 1,
  }
  edits.applyOp({ type: 'addObject', object: object as EditObject }, 'Draw')
}

onBeforeUnmount(reset)
</script>

<template>
  <!--
    A transient canvas, NOT the SVG overlay: the in-flight stroke is redrawn
    on every pointermove, and doing that through the DOM would mean hundreds
    of element mutations a second. It holds nothing once the stroke commits.
  -->
  <canvas
    v-if="tools.active === 'ink'"
    ref="surface"
    data-ink-canvas
    class="pointer-events-auto absolute inset-0 size-full cursor-crosshair"
    @pointerdown="onPointerDown"
  />
</template>
