<script setup lang="ts">
import { computed } from 'vue'
import { pageViewSize } from '@margin/transform'
import type { PageQuadIndex } from '@margin/pdf-core'
import type { PageState } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { alignmentRails } from './alignmentRails'

/**
 * The rails a dragged line can be lined up against.
 *
 * Shown ONLY while a line is in flight. They are feedback for a gesture,
 * not decoration, and a page permanently overlaid with dashed lines is a
 * page nobody can read.
 *
 * Rendered in MuPDF page space, OUTSIDE the overlay's y-flipped root <g> --
 * the same treatment the patches themselves get, and for the same reason:
 * the coordinates come from the extraction, which is top-down.
 *
 * Advisory, not a constraint. The rails say where the page's own columns
 * and baselines are; they do not stop the line going anywhere else. That is
 * deliberate -- the reason to move a line is often that it does not belong
 * in any of the places the document already uses.
 */
const props = defineProps<{ page: PageState; index?: PageQuadIndex | undefined }>()

const edits = useEditsStore()
const tools = useToolsStore()

/** The patch being dragged, if it is one and it is on THIS page. */
const moving = computed(() => {
  const id = tools.movingPatchId
  const o = id ? edits.doc.objects[id] : undefined
  return o && o.kind === 'textPatch' && o.pageId === props.page.id ? o : undefined
})

const rails = computed(() => {
  const o = moving.value
  if (!o || !props.index) return { xs: [], ys: [] }
  return alignmentRails(props.index, { exclude: o.lineIndex })
})

/**
 * The page's displayed extent in points -- the same numbers the overlay's
 * viewBox is built from, so a rail drawn to them reaches both edges exactly.
 */
const extent = computed(() => pageViewSize(props.page.geometry, 1))
</script>

<template>
  <g v-if="moving" data-alignment-guides aria-hidden="true" class="pointer-events-none">
    <!--
      `non-scaling-stroke` keeps a rail one CSS pixel wide at every zoom.
      Without it the stroke is measured in points and a rail drawn at 400%
      is four pixels of solid colour across the page.
    -->
    <line
      v-for="x in rails.xs"
      :key="`x${x}`"
      :x1="x"
      :y1="0"
      :x2="x"
      :y2="extent.height"
      class="stroke-accent/40"
      stroke-width="1"
      stroke-dasharray="3 3"
      vector-effect="non-scaling-stroke"
    />
    <line
      v-for="y in rails.ys"
      :key="`y${y}`"
      :x1="0"
      :y1="y"
      :x2="extent.width"
      :y2="y"
      class="stroke-accent/40"
      stroke-width="1"
      stroke-dasharray="3 3"
      vector-effect="non-scaling-stroke"
    />
  </g>
</template>
