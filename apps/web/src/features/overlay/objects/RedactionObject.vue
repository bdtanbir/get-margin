<script setup lang="ts">
import { computed } from 'vue'
import type { RedactionObject } from '@margin/pdf-core'

const props = defineProps<{ object: RedactionObject }>()

/**
 * Quads are MuPDF PAGE space (top-down), like MarkupObject's -- so this
 * renders OUTSIDE the overlay's y-flipped root <g>, and PageOverlay places
 * it with the markup layer for exactly that reason.
 */
const polygons = computed(() =>
  props.object.quads.map((q) => `${q[0]},${q[1]} ${q[2]},${q[3]} ${q[6]},${q[7]} ${q[4]},${q[5]}`),
)
</script>

<template>
  <!--
    OPAQUE BLACK, and fully so. Every other overlay affordance is a hint
    about something the export will do; this one is a picture of the result.
    A translucent preview would show the user the words that are about to be
    destroyed, which reads as "still there" at exactly the moment they need
    to believe otherwise.

    When blackBox is off the export draws no mark -- but the EDITOR still
    must, or a redaction becomes invisible while it is being placed and the
    user cannot tell which words they have selected. The dashed outline is
    the honest version of that: it marks the region without claiming the
    exported file will show one.
  -->
  <g>
    <polygon
      v-for="(points, i) in polygons"
      :key="i"
      :points="points"
      :fill="props.object.blackBox ? '#000' : 'none'"
      :stroke="props.object.blackBox ? 'none' : '#000'"
      stroke-width="1"
      :stroke-dasharray="props.object.blackBox ? undefined : '3 2'"
      vector-effect="non-scaling-stroke"
    />
  </g>
</template>
