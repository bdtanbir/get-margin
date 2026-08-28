<script setup lang="ts">
import { ref } from 'vue'
import { nanoid } from 'nanoid'
import type { EditObject, RegionPatchObject } from '@margin/pdf-core'
import type { PageState } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { useViewportStore } from '@/stores/viewport'
import { getPdfClient } from '@/workers/pdfClient'
import { sampleBackground } from './sampleBackground'
import { plainColor, plainRect } from './linePatch'

/**
 * Drag a box around any part of the page and lift it out as one piece.
 *
 * The answer to what `ImageEditor` cannot reach. A great deal of what a
 * reader calls "the logo" is not an image: page 2 of a real US-Bangla
 * e-ticket draws the same logo page 1 embeds as a 1200x286 raster using 21
 * vector paths instead. No image walk finds it, and clustering those paths
 * into "the logo" is a heuristic that eventually takes the rule beside
 * them. Letting the boundary be drawn costs one gesture and is never
 * wrong about what the user meant.
 */
const props = defineProps<{ page: PageState; zoom: number }>()

const edits = useEditsStore()
const tools = useToolsStore()
const vp = useViewportStore()

/**
 * The resolution a lifted area is rasterised at, in multiples of its size
 * on the page -- about 288dpi.
 *
 * A fixed number, unlike `ImageEditor`'s, which reads the density of the
 * image it is lifting. A region has no source resolution to read: it may
 * hold vector paths that are sharp at any scale, text, a photograph, or
 * all three. `cropRegion` drops this if the area is large enough to blow
 * its pixel budget.
 */
const LIFT_SCALE = 4

/**
 * The smallest area worth lifting, in points.
 *
 * Below this the gesture was almost certainly a click on the page rather
 * than a drag, and lifting a 2pt square would leave an object the user
 * cannot see, cannot find, and did not ask for.
 */
const MIN_SIZE_PT = 6

/** How far out the background is sampled from the area's edge, in points. */
const SAMPLE_BAND_PT = 6

/** The box being drawn right now, in page space. Undefined between drags. */
const draft = ref<{ x: number; y: number; w: number; h: number } | undefined>(undefined)
const busy = ref(false)

/** Page space from a client point: this overlay's view IS page space, scaled. */
function toPage(e: PointerEvent, el: Element): { x: number; y: number } {
  const box = el.getBoundingClientRect()
  return { x: (e.clientX - box.left) / props.zoom, y: (e.clientY - box.top) / props.zoom }
}

async function lift(rect: { x: number; y: number; w: number; h: number }): Promise<void> {
  const bitmap = vp.bitmapFor(props.page.id)
  const scale = bitmap ? bitmap.scale : 1
  const background = sampleBackground(bitmap, rect, scale, SAMPLE_BAND_PT * scale)

  const crop = await getPdfClient().regionCrop(
    props.page.sourceId, props.page.sourceIndex, rect, LIFT_SCALE,
  )
  // No pixels means no lift. Covering the area and drawing nothing back
  // would read as a deletion the user did not ask for.
  if (!crop) return

  const object: RegionPatchObject = {
    id: nanoid(10),
    pageId: props.page.id,
    kind: 'regionPatch',
    background: plainColor(background.color),
    backgroundConfidence: background.confidence,
    data: crop.data,
    mime: 'image/png',
    rect,
    rotation: 0,
    z: edits.nextZ(),
    locked: false,
    opacity: 1,
  }
  edits.applyOp({ type: 'addObject', object: object as EditObject }, 'Lift area')

  /**
   * Hand the user the select tool with the new piece already selected.
   *
   * The next thing anybody does after lifting something is move it, and
   * moving is the select tool's gesture. Leaving them in lift mode would
   * mean the obvious next drag draws another box over the thing they just
   * lifted.
   */
  tools.setTool('select')
  edits.select([object.id])
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 || busy.value) return
  const surface = e.currentTarget as Element
  const start = toPage(e, surface)
  try {
    surface.setPointerCapture?.(e.pointerId)
  } catch {
    // Best-effort; the window listeners below are the guarantee.
  }

  const move = (ev: Event): void => {
    const at = toPage(ev as PointerEvent, surface)
    draft.value = {
      x: Math.min(start.x, at.x),
      y: Math.min(start.y, at.y),
      w: Math.abs(at.x - start.x),
      h: Math.abs(at.y - start.y),
    }
  }

  const end = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    try {
      surface.releasePointerCapture?.(e.pointerId)
    } catch {
      // Already released, or never captured.
    }
    // PLAIN, not the ref's Proxy. `draft` is a ref holding an object, so
    // reading it back gives a deeply reactive Proxy -- which cannot cross
    // `postMessage` and must never enter the edit document. See
    // `plainRect`.
    const drawn = draft.value
    const rect = drawn ? plainRect(drawn) : undefined
    draft.value = undefined
    if (!rect || rect.w < MIN_SIZE_PT || rect.h < MIN_SIZE_PT) return
    busy.value = true
    void lift(rect).finally(() => { busy.value = false })
  }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
}
</script>

<template>
  <!--
    `touch-none` for the reason InkCanvas needs it: the scroller declares
    `pan-x pan-y`, and without an override the browser is entitled to read a
    one-finger drag that starts here as a pan and take the gesture away
    mid-drag. The surface only exists while this tool is active, so opting
    out of panning here costs nothing.
  -->
  <div
    data-lift-surface
    class="pointer-events-auto absolute inset-0 cursor-crosshair touch-none"
    @pointerdown="onPointerDown"
  >
    <div
      v-if="draft"
      data-lift-draft
      aria-hidden="true"
      class="pointer-events-none absolute border-2 border-dashed border-accent bg-accent/10"
      :style="{
        left: `${draft.x * props.zoom}px`,
        top: `${draft.y * props.zoom}px`,
        width: `${draft.w * props.zoom}px`,
        height: `${draft.h * props.zoom}px`,
      }"
    />
  </div>
</template>
