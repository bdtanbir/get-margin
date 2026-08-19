<script setup lang="ts">
import { computed } from 'vue'
import type { Quad } from '@margin/pdf-core'
import { useSelectionStore } from '@/stores/selection'
import type { PageState } from '@/stores/document'

const props = defineProps<{ page: PageState }>()
const selection = useSelectionStore()

/**
 * MuPDF quad order is upper-left, upper-right, lower-left, lower-right, so
 * the polygon has to visit them as UL -> UR -> LR -> LL. Emitting them in
 * array order would draw a bow tie.
 */
function polygon(q: Quad): string {
  return `${q[0]},${q[1]} ${q[2]},${q[3]} ${q[6]},${q[7]} ${q[4]},${q[5]}`
}

const quads = computed(() =>
  selection.pageId === props.page.id ? selection.selectedQuads : [],
)
</script>

<template>
  <!--
    Rendered OUTSIDE the overlay's y-flipped root <g>, because these quads
    are already in MuPDF PAGE space (top-down, CropBox-normalised, /Rotate
    applied) -- the same space the viewBox describes. Putting them inside
    the root group would apply the page transform a second time.
  -->
  <polygon
    v-for="(q, i) in quads"
    :key="i"
    :points="polygon(q)"
    fill="rgb(59,130,246)"
    fill-opacity="0.3"
    class="pointer-events-none"
  />
</template>
