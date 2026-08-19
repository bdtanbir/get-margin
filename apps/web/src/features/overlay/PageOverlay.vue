<script setup lang="ts">
import { computed } from 'vue'
import { svgViewBox, svgRootTransform } from '@margin/transform'
import type { PageState } from '@/stores/document'
import type { EditObject } from '@margin/pdf-core'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import ObjectLayer from './ObjectLayer.vue'
import SelectionChrome from './SelectionChrome.vue'
import SelectionToolbar from '@/features/tools/SelectionToolbar.vue'
import { useDrawTool, isDrawable, draftDefaults } from './useDrawTool'

const props = defineProps<{ page: PageState; zoom: number }>()
const edits = useEditsStore()

/**
 * Spec 1.3, Layer 2. The viewBox is the page's DISPLAYED extent in points
 * and the root <g> carries all three of MuPDF's baked-in page-space
 * transforms (CropBox origin to (0,0), y-flip, /Rotate). Both strings come
 * from @margin/transform, which is property-tested against MuPDF's own
 * getTransform() matrices -- this component must never compute either
 * itself. Consequence: objects below render at raw stored PDF coordinates
 * with no per-object maths, and zoom never touches this markup.
 */
const viewBox = computed(() => svgViewBox(props.page.geometry))
const rootTransform = computed(() => svgRootTransform(props.page.geometry))

const objects = computed(() =>
  Object.values(edits.doc.objects)
    .filter((o) => o.pageId === props.page.id)
    .sort((a, b) => a.z - b.z),
)

const tools = useToolsStore()
const draw = useDrawTool(() => props.page, () => props.zoom)

/**
 * The capture surface exists only while a drawing tool is active. A
 * permanently-mounted pointer-events-auto layer over the page would swallow
 * every click meant for an object beneath it, which is exactly the bug the
 * pointer-events-none default on the <svg> avoids.
 */
const drawing = computed(() => isDrawable(tools.active))

/**
 * The in-flight shape, rendered from the SAME components the committed
 * objects use so the preview cannot drift from the result. Synthesised
 * rather than stored: a draft is not an EditObject and must never reach
 * edit history.
 */
const draft = computed(() => {
  const d = tools.draft
  if (!d || d.pageId !== props.page.id || !isDrawable(tools.active)) return undefined
  return {
    ...draftDefaults(tools.active),
    id: '__draft__',
    pageId: d.pageId,
    kind: tools.active,
    rect: d.rect,
    rotation: 0,
    z: 0,
    locked: false,
    opacity: 1,
  } as EditObject
})
</script>

<template>
  <!--
    pointer-events-none on the <svg> with pointer-events-auto per object
    (see ObjectLayer): the overlay covers the whole page, so a
    pointer-transparent default is what keeps text selection, scrolling, and
    the page canvas beneath it reachable. Individual objects opt back in.

    No width/height attributes: the element is stretched by `inset-0
    size-full` to exactly the canvas box PageCanvas established from the
    same geometry, so the two can never disagree about size.
  -->
  <div class="pointer-events-none absolute inset-0">
    <svg
      class="pointer-events-none absolute inset-0 size-full"
      :viewBox="viewBox"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <g :transform="rootTransform">
        <!--
          Hit-testing lives here rather than on the <svg>: ObjectLayer's <g>
          is pointer-events-auto inside a pointer-events-none <svg>, so a
          pointerdown that reaches this handler landed on an object's own
          painted geometry. Everywhere else stays transparent to the canvas,
          text selection, and scrolling beneath.
        -->
        <ObjectLayer
          v-for="o in objects"
          :key="o.id"
          :object="o"
          @pointerdown="edits.select([o.id])"
        />
        <ObjectLayer v-if="draft" :object="draft" />
      </g>
    </svg>
    <!--
      Mounted only while a drawing tool is active, and AFTER the <svg> so it
      sits above the objects: while drawing, a pointerdown belongs to the new
      shape, not to whatever happens to be underneath.
    -->
    <div
      v-if="drawing"
      data-draw-surface
      class="pointer-events-auto absolute inset-0 cursor-crosshair"
      @pointerdown="draw.onPointerDown"
    />
    <!--
      Layer 3 sits OUTSIDE the <svg> (spec 1.3) and positions against this
      same box, so its DOM handles get ordinary Tailwind, focus, and mobile
      keyboard behaviour.
    -->
    <SelectionChrome :page="props.page" :zoom="props.zoom" />
    <SelectionToolbar :page="props.page" :zoom="props.zoom" />
  </div>
</template>
