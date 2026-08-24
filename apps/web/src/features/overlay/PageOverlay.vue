<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { svgViewBox, svgRootTransform } from '@margin/transform'
import type { PageState } from '@/stores/document'
import type { EditObject } from '@margin/pdf-core'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import ObjectLayer from './ObjectLayer.vue'
import SelectionChrome from './SelectionChrome.vue'
import TextEditor from './TextEditor.vue'
import InkCanvas from './InkCanvas.vue'
import CropOverlay from '@/features/pages/CropOverlay.vue'
import TextSelectionLayer from './TextSelectionLayer.vue'
import MarkupObject from './objects/MarkupObject.vue'
import RedactionObject from './objects/RedactionObject.vue'
import TextPatchObject from './objects/TextPatchObject.vue'
import { isMarkupKind } from './objects/registry'
import { useTextSelection } from './useTextSelection'
import { useSelectionStore } from '@/stores/selection'
import { useViewportStore } from '@/stores/viewport'
import { useDocumentStore } from '@/stores/document'
import { getPdfClient } from '@/workers/pdfClient'
import SelectionToolbar from '@/features/tools/SelectionToolbar.vue'
import { useDrawTool, isDrawable, draftDefaults } from './useDrawTool'
import FieldLayer from '@/features/forms/FieldLayer.vue'
import FindHighlights from '@/features/find/FindHighlights.vue'
import PatchEditor from '@/features/patch/PatchEditor.vue'

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

// Kinds whose geometry is MuPDF PAGE space rather than raw PDF space, so
// they render OUTSIDE the y-flipped root <g>. Redaction joins the markup
// three because its quads come from the same buildQuadIndex, and textPatch
// joins them because its rect is derived from that index's character quads
// (see PatchEditor's `box`). The list lives beside the renderer table so
// the two can be checked against the format's own list of kinds.
const isMarkup = isMarkupKind

const onPage = computed(() =>
  Object.values(edits.doc.objects)
    .filter((o) => o.pageId === props.page.id)
    .sort((a, b) => a.z - b.z),
)

/**
 * Everything drawn in raw PDF space -- minus whatever is being edited.
 *
 * A text object under the caret is drawn by TextEditor as a real
 * contenteditable in the DOM. Leaving the SVG copy up as well drew the same
 * string twice, a couple of pixels apart, which reads exactly like a drop
 * shadow and vanished the moment the editor closed.
 */
const objects = computed(() =>
  onPage.value.filter((o) => !isMarkup(o.kind) && o.id !== tools.editingId),
)

/**
 * Markup objects render OUTSIDE the y-flipped root <g>: their quads are in
 * MuPDF PAGE space (top-down), unlike every other object's raw bottom-up
 * rect. Putting them inside would flip them onto the mirror image of the
 * text they mark -- which is precisely the bug the export path's
 * markup.test.ts pins on the other side.
 */
const markup = computed(() => onPage.value.filter((o) => isMarkup(o.kind)))

const tools = useToolsStore()
const docStore = useDocumentStore()
const draw = useDrawTool(() => props.page, () => props.zoom)

const selection = useSelectionStore()
const vp = useViewportStore()

/** This page's position in display order, for the anchor comparison above. */
const pageIndex = computed(() => docStore.pageOrder.indexOf(props.page.id))
const svgEl = ref<SVGSVGElement | null>(null)

/**
 * Text selection is available under the select tool and under the three
 * markup tools, which is exactly when the user is pointing at TEXT rather
 * than drawing over it.
 */
// The patch tool needs the quad index too -- it edits the lines that
// index describes -- so it counts as a text-selecting mode for the
// purpose of fetching one, even though it does not select.
const SELECTING_TOOLS = ['select', 'highlight', 'underline', 'strikeout', 'redact', 'patch'] as const
const selecting = computed(() =>
  (SELECTING_TOOLS as readonly string[]).includes(tools.active),
)

/**
 * The quad index is fetched lazily, once per page, and only when the user
 * is actually in a text-selecting mode -- extracting every glyph on a page
 * the user is merely scrolling past would be pure waste.
 */
const quadIndex = ref<Awaited<ReturnType<ReturnType<typeof getPdfClient>['quadIndex']>> | undefined>(undefined)
let requested = false

async function ensureIndex(): Promise<void> {
  if (requested || !selecting.value) return
  requested = true
  try {
    // BOTH halves of the identity: which file, and which page of it.
    // Passing only `sourceIndex` meant page two of a merge asked for "page
    // 0" and was handed page one of the first file.
    quadIndex.value = await getPdfClient().quadIndex(props.page.sourceId, props.page.sourceIndex)
  } catch {
    // Text extraction failing is not a reason to break the overlay: the
    // page still renders and every drawing tool still works.
    requested = false
  }
}

watch(selecting, (on) => { if (on) void ensureIndex() }, { immediate: true })

const text = useTextSelection(() => props.page.id, () => quadIndex.value, {
  /**
   * getScreenCTM().inverse() -- the browser owns this conversion (spec 1.4).
   * The <svg>'s own user space IS page space, because the viewBox is the
   * page's displayed extent in points; the y-flip lives on the inner <g>,
   * which these quads deliberately sit outside of.
   */
  toPageSpace(clientX, clientY) {
    const svg = svgEl.value
    const ctm = svg?.getScreenCTM?.()
    if (!svg || !ctm) return undefined
    const point = svg.createSVGPoint()
    point.x = clientX
    point.y = clientY
    const local = point.matrixTransform(ctm.inverse())
    return { x: local.x, y: local.y }
  },
})

onBeforeUnmount(() => {
  if (selection.pageId === props.page.id) selection.clear()
})

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
    <!--
      BELOW the <svg> in the stack, deliberately. Objects inside the svg are
      pointer-events-auto over a pointer-events-none svg, so a click on an
      object reaches the object and a click on bare page falls through to
      this. Placing it above would make every object unselectable under the
      select tool. Mounted only in text-selecting modes, so a drawing tool's
      drag is never intercepted by it either.
    -->
    <div
      v-if="selecting"
      data-text-surface
      class="pointer-events-auto absolute inset-0 cursor-text"
      @pointerdown="text.onPointerDown"
    />
    <!--
      AFTER the text surface and BEFORE the <svg>, and both halves matter.

      Before the svg, so the user's own objects paint and hit-test above the
      form: an annotation drawn over a field is reachable, which is what
      drawing it on top meant.

      After the text surface, because that surface is pointer-events-auto
      and covers the whole page whenever the select tool is active. Mounted
      earlier, FieldLayer sat UNDERNEATH it and every field became
      unclickable -- a checkbox could not be ticked at all. It looked fine
      in unit tests, which dispatch events at elements directly, and in any
      e2e step using fill(), which focuses rather than clicks. Only a real
      click found it.
    -->
    <FieldLayer :page="props.page" :zoom="props.zoom" />
    <svg
      ref="svgEl"
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
          @dblclick="o.kind === 'text' && tools.startEditing(o.id)"
        />
        <ObjectLayer v-if="draft" :object="draft" />
      </g>
      <!--
        OUTSIDE the root <g>: these quads are already in MuPDF page space,
        which is what the viewBox describes. Inside, the page transform would
        be applied to them a second time.
      -->
      <g
        v-for="o in markup"
        :key="o.id"
        :data-object-id="o.id"
        :opacity="o.opacity"
        class="pointer-events-auto"
        @pointerdown="edits.select([o.id])"
      >
        <RedactionObject v-if="o.kind === 'redaction'" :object="(o as never)" />
        <TextPatchObject v-else-if="o.kind === 'textPatch'" :object="(o as never)" />
        <MarkupObject v-else :object="(o as never)" />
      </g>
      <TextSelectionLayer :page="props.page" />
      <!--
        Above the text selection layer and below the objects: a search
        result is a thing the DOCUMENT contains, so it should not obscure
        what the user has drawn on top of it.
      -->
      <FindHighlights :page="props.page" />
    </svg>

    <!--
      Mounted only while a drawing tool is active, and AFTER the <svg> so it
      sits above the objects: while drawing, a pointerdown belongs to the new
      shape, not to whatever happens to be underneath.
    -->
    <!--
      `touch-none` is what makes drawing work with a finger.

      PageList's scroller declares `touch-action: pan-x pan-y`, and the
      effective value is the INTERSECTION down the ancestor chain -- so
      without an override here the browser is entitled to read a one-finger
      drag that starts on this surface as a pan. It then scrolls the
      document under the finger while the draft rectangle is being sized
      against a moving origin, and may take the gesture away outright with
      a `pointercancel`. `none` is the only value that overrides `pan-x
      pan-y` completely; `manipulation` still permits panning.

      This surface only exists while a drawing tool is active, so opting
      out of panning here costs nothing: with the select tool the surface
      is unmounted and one-finger scrolling over the page is unaffected.
    -->
    <div
      v-if="drawing"
      data-draw-surface
      class="pointer-events-auto absolute inset-0 cursor-crosshair touch-none"
      @pointerdown="draw.onPointerDown"
    />
    <!--
      Layer 3 sits OUTSIDE the <svg> (spec 1.3) and positions against this
      same box, so its DOM handles get ordinary Tailwind, focus, and mobile
      keyboard behaviour.
    -->
    <SelectionChrome :page="props.page" :zoom="props.zoom" />
    <SelectionToolbar :page="props.page" :zoom="props.zoom" />
    <TextEditor :page="props.page" :zoom="props.zoom" />
    <InkCanvas :page="props.page" :zoom="props.zoom" />
    <!--
      Only while the tool is active: a layer of per-line click targets over
      every page would swallow every other interaction.
    -->
    <PatchEditor
      v-if="tools.active === 'patch'"
      :page="props.page"
      :zoom="props.zoom"
      :index="quadIndex"
    />
    <!--
      Only on the anchor page: cropping is a page action and showing a
      dimmed crop surface on every mounted page at once would be noise.
    -->
    <CropOverlay
      v-if="tools.active === 'crop' && vp.anchorIndex === pageIndex"
      :page="props.page"
      :zoom="props.zoom"
    />
  </div>
</template>
