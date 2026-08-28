<script setup lang="ts">
import { computed } from 'vue'
import { nanoid } from 'nanoid'
import { viewDeltaToPage } from '@margin/transform'
import type {
  EditObject, ImagePatchObject, ImagePlacement, PageImageIndex,
} from '@margin/pdf-core'
import type { PageState } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { useViewportStore } from '@/stores/viewport'
import { getPdfClient } from '@/workers/pdfClient'
import { sampleBackground, CONFIDENT_ENOUGH } from './sampleBackground'
import { plainColor } from './linePatch'

/**
 * One click target per image the document draws, while the Edit image tool
 * is active.
 *
 * The sibling of `PatchEditor`, and the same shape: a layer of targets over
 * what the page already contains, mounted only while its tool is active
 * because a permanent layer of hit targets over every page would swallow
 * every other interaction.
 *
 * CLICK SELECTS, DRAG MOVES. One gesture each, on the same target, told
 * apart by whether the pointer travelled -- which is how every direct
 * manipulation surface people already use behaves.
 *
 * Clicking used to REMOVE the image outright, and that was wrong twice
 * over. It destroyed something on a single click with no confirmation and
 * no visible route back, and it left the user with no way to reach the
 * ordinary object controls -- duplicate, order, lock, delete -- that every
 * other thing on the page has. Those controls already exist and already
 * work; the image simply had no object for them to point at until it had
 * been dragged.
 *
 * So a click now LIFTS the image in place -- a cover with a copy of the
 * image drawn exactly where it already was, which changes nothing anybody
 * can see -- and hands over the select tool with it selected. Removing it
 * is then the same Delete as everywhere else in the app.
 */
const props = defineProps<{
  page: PageState
  zoom: number
  index: PageImageIndex | undefined
}>()

const edits = useEditsStore()
const tools = useToolsStore()
const vp = useViewportStore()

/**
 * How far out the background is sampled from an image's edge, in points.
 *
 * A cap, passed to `sampleBackground`, which would otherwise reach a third
 * of the box's height in every direction -- 33pt for a 100pt logo, far
 * enough to swallow a neighbouring table and report the paper behind the
 * logo as "varied".
 */
const SAMPLE_BAND_PT = 6

/**
 * How far the pointer must travel before a press becomes a drag, in CSS
 * pixels. Below it the gesture is a click, and a click removes.
 *
 * Generous rather than tight: a press that wobbles by a pixel on a laptop
 * trackpad is a click, and reading it as a one-pixel move would leave the
 * user with an image they did not mean to lift and cannot see they have.
 */
const DRAG_THRESHOLD_PX = 4

/**
 * The resolution a moved image is rasterised at, in multiples of its size
 * on the page.
 *
 * Taken from the image's OWN pixel density -- a 1200px logo occupying
 * 207.8pt is oversampled about 5.8x, and rendering the crop at that ratio
 * loses nothing visible. Clamped at both ends: below 2 a crop of an
 * already-coarse image would be visibly softer than the original, and
 * above 8 a full-page graphic would produce a raster larger than the
 * document it is going into.
 */
const MIN_CROP_SCALE = 2
const MAX_CROP_SCALE = 8

function cropScale(place: ImagePlacement): number {
  const w = place.bbox[2] - place.bbox[0]
  const h = place.bbox[3] - place.bbox[1]
  if (w <= 0 || h <= 0) return MIN_CROP_SCALE
  const density = Math.max(place.width / w, place.height / h)
  return Math.min(MAX_CROP_SCALE, Math.max(MIN_CROP_SCALE, Math.ceil(density)))
}

/** The patch covering an image, if the user has already touched it. */
function patchOn(imageIndex: number): ImagePatchObject | undefined {
  for (const o of Object.values(edits.doc.objects)) {
    if (o.kind === 'imagePatch' && o.pageId === props.page.id && o.imageIndex === imageIndex) {
      return o
    }
  }
  return undefined
}

const placements = computed(() => props.index?.images ?? [])

/**
 * Where an image ACTUALLY IS: its box in the source page, plus whatever
 * the user has dragged it by.
 *
 * Everything the user points at goes through this. Reading the raw
 * placement instead left the target behind on the blank rectangle a moved
 * logo had vacated -- the logo they could see had no target at all, and
 * clicking where it now sat grabbed nothing. `PatchEditor` carries the
 * same function for the same reason; this tool was written without it.
 *
 * The COVER does not move, and neither does the placement -- the
 * document's own image is still where it always was, underneath. This is
 * the copy's position, which is the only one anybody can see.
 */
function targetBox(place: ImagePlacement): { x: number; y: number; w: number; h: number } {
  const patch = patchOn(place.index)
  const { dx = 0, dy = 0 } = patch?.offset ?? {}
  return {
    x: place.bbox[0] + dx,
    y: place.bbox[1] + dy,
    // The copy's own size once it has been resized, so the target keeps
    // matching the thing on screen rather than the area underneath it.
    w: patch?.size?.w ?? place.bbox[2] - place.bbox[0],
    h: patch?.size?.h ?? place.bbox[3] - place.bbox[1],
  }
}

/**
 * What is behind an image, sampled from the page AS RENDERED.
 *
 * Done here rather than in the writer for the same reason the text patch
 * does it here: the app already has the pixels on screen, and the writer
 * would have to rasterise a page per patch to learn the same thing.
 */
function backgroundFor(bbox: readonly [number, number, number, number]) {
  const bitmap = vp.bitmapFor(props.page.id)
  const scale = bitmap ? bitmap.scale : 1
  return sampleBackground(
    bitmap,
    { x: bbox[0], y: bbox[1], w: bbox[2] - bbox[0], h: bbox[3] - bbox[1] },
    scale,
    SAMPLE_BAND_PT * scale,
  )
}

/** Whether a flat cover over this image is likely to show. */
function risky(bbox: readonly [number, number, number, number]): boolean {
  return backgroundFor(bbox).confidence < CONFIDENT_ENOUGH
}

/** A patch over one placement, with whatever the caller needs added. */
function buildPatch(place: ImagePlacement, extra: Partial<ImagePatchObject> = {}): ImagePatchObject {
  const background = backgroundFor(place.bbox)
  return {
    id: nanoid(10),
    pageId: props.page.id,
    kind: 'imagePatch',
    imageIndex: place.index,
    // Taken from the placement as it is RIGHT NOW, which is what makes the
    // writer's guard meaningful rather than circular: it re-walks the page
    // at export and refuses if the image there is no longer this one.
    originalHash: place.hash,
    background: plainColor(background.color),
    backgroundConfidence: background.confidence,
    rect: {
      x: place.bbox[0],
      y: place.bbox[1],
      w: place.bbox[2] - place.bbox[0],
      h: place.bbox[3] - place.bbox[1],
    },
    rotation: 0,
    z: edits.nextZ(),
    locked: false,
    opacity: 1,
    ...extra,
  }
}

/**
 * Hand the object to the select tool.
 *
 * The next thing anybody does with something they clicked is act on it,
 * and every action lives on the selection toolbar.
 */
function handOver(id: string): void {
  tools.setTool('select')
  edits.select([id])
}

/** Click: select the image, lifting it first if it is not an object yet. */
async function selectOrLift(place: ImagePlacement): Promise<void> {
  const existing = patchOn(place.index)
  if (existing) {
    handOver(existing.id)
    return
  }
  const id = await lift(place)
  if (id) handOver(id)
}

/**
 * Lift an image so it can be dragged: give its patch a raster of itself.
 *
 * Returns the id to accumulate the drag into, or undefined if the crop
 * could not be produced -- in which case the gesture does nothing rather
 * than moving a cover and leaving the image behind it visible.
 */
async function lift(place: ImagePlacement): Promise<string | undefined> {
  const crop = await getPdfClient().imageCrop(
    props.page.sourceId, props.page.sourceIndex, place.index, cropScale(place),
  )
  if (!crop) return undefined

  const existing = patchOn(place.index)
  if (existing) {
    edits.applyOp(
      { type: 'updateObject', id: existing.id, patch: { data: crop.data, mime: 'image/png' } },
      'Select image',
    )
    return existing.id
  }
  const object = buildPatch(place, { data: crop.data, mime: 'image/png' })
  edits.applyOp({ type: 'addObject', object: object as EditObject }, 'Select image')
  return object.id
}

/**
 * Press, drag, release, on one target.
 *
 * The crop is fetched from the worker the moment the press becomes a drag,
 * which is asynchronous while the pointer keeps moving -- so the latest
 * delta is remembered and applied when the patch exists, rather than the
 * frames before it arrives being dropped. Without that the image jumps to
 * wherever the pointer happened to be when the round trip finished.
 */
function onPointerDown(place: ImagePlacement, e: PointerEvent): void {
  // Only the primary button starts a gesture; a right-click is the
  // browser's, not ours.
  if (e.button !== 0) return

  const startX = e.clientX
  const startY = e.clientY
  const from = (() => {
    const existing = patchOn(place.index)
    return { dx: existing?.offset?.dx ?? 0, dy: existing?.offset?.dy ?? 0 }
  })()

  let dragging = false
  let id: string | undefined
  let latest = { dx: 0, dy: 0 }
  /** The in-flight lift, so `end` can wait for it rather than race it. */
  let lifting: Promise<string | undefined> | undefined

  const target = e.currentTarget as Element | null
  try {
    target?.setPointerCapture?.(e.pointerId)
  } catch {
    // Best-effort; the window listeners below are the guarantee.
  }

  const apply = (): void => {
    if (!id) return
    // Page space is top-down like the screen, so no sign flips -- the only
    // conversion is out of CSS pixels. Inverting it is the writer's job.
    const d = viewDeltaToPage(
      { x: latest.dx, y: latest.dy }, props.page.geometry, props.zoom,
    )
    edits.applyOp(
      {
        type: 'updateObject',
        id,
        patch: { offset: { dx: from.dx + d.x, dy: from.dy + d.y } },
      },
      'Move image',
    )
  }

  const move = (ev: Event): void => {
    const p = ev as PointerEvent
    latest = { dx: p.clientX - startX, dy: p.clientY - startY }
    if (!dragging) {
      if (Math.hypot(latest.dx, latest.dy) < DRAG_THRESHOLD_PX) return
      dragging = true
      lifting = lift(place)
      void lifting.then((lifted) => {
        id = lifted
        apply()
      })
      return
    }
    apply()
  }

  const end = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    try {
      target?.releasePointerCapture?.(e.pointerId)
    } catch {
      // Already released, or never captured.
    }
    if (!dragging) {
      void selectOrLift(place)
      return
    }
    // A drag ends the same way a click does: with the thing selected and
    // the select tool in hand, so the toolbar is there to act on it.
    void lifting?.then((lifted) => { if (lifted) handOver(lifted) })
  }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
}
</script>

<template>
  <div class="pointer-events-none absolute inset-0" data-image-layer>
    <!--
      Marked by confidence BEFORE the user commits, exactly as the line
      targets are: an image over a gradient can be covered, but the flat
      rectangle will show, and finding that out in the exported file is
      finding out too late.

      `touch-none` for the same reason InkCanvas needs it: the scroller
      declares `pan-x pan-y`, and without an override the browser is
      entitled to read a one-finger drag that starts here as a pan and take
      the gesture away mid-move.
    -->
    <button
      v-for="place in placements"
      :key="place.index"
      type="button"
      class="pointer-events-auto absolute cursor-grab touch-none border-2 border-dashed
             transition-colors active:cursor-grabbing"
      :class="patchOn(place.index)
        ? 'border-accent bg-accent/20'
        : risky(place.bbox)
          ? 'border-warning/70 hover:bg-warning/20'
          : 'border-accent/40 hover:bg-accent/15'"
      :style="{
        left: `${targetBox(place).x * props.zoom}px`,
        top: `${targetBox(place).y * props.zoom}px`,
        width: `${targetBox(place).w * props.zoom}px`,
        height: `${targetBox(place).h * props.zoom}px`,
      }"
      :data-image-target="place.index"
      :title="risky(place.bbox)
        ? 'Click to select it, or drag to move it — the area behind it is not a flat colour, so removing it may leave a mark'
        : 'Click to select it, or drag to move it'"
      :aria-label="`Select image ${place.index + 1}`"
      @pointerdown="(e) => onPointerDown(place, e)"
    />
  </div>
</template>
