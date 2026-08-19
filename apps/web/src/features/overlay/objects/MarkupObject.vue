<script setup lang="ts">
import { computed } from 'vue'
import type { MarkupObject } from '@margin/pdf-core'
import { rgb } from './svgPaint'

const props = defineProps<{ object: MarkupObject }>()

/**
 * Quads are in MuPDF PAGE space (top-down), unlike every other object's
 * geometry -- see the MarkupObject type. This component is therefore
 * rendered OUTSIDE the overlay's y-flipped root <g>; PageOverlay places it
 * accordingly.
 *
 * Corner order is upper-left, upper-right, lower-left, lower-right, so a
 * polygon must visit them UL -> UR -> LR -> LL or it draws a bow tie.
 */
const shapes = computed(() =>
  props.object.quads.map((q) => {
    const [ulx, uly, urx, , llx, lly, lrx] = q as unknown as number[]
    const top = uly!
    const bottom = lly!
    return {
      polygon: `${ulx},${uly} ${urx},${q[3]} ${lrx},${q[7]} ${llx},${lly}`,
      left: Math.min(ulx!, llx!),
      right: Math.max(urx!, lrx!),
      // Underline sits on the baseline edge; strikeout across the middle.
      underlineY: bottom,
      strikeY: (top + bottom) / 2,
      thickness: Math.max(1, (bottom - top) * 0.07),
    }
  }),
)

const colour = computed(() => rgb(props.object.color))
</script>

<template>
  <g>
    <template v-for="(s, i) in shapes" :key="i">
      <!-- Highlight: a translucent wash, matching the annotation's own /AP. -->
      <polygon
        v-if="props.object.kind === 'highlight'"
        :points="s.polygon"
        :fill="colour"
        fill-opacity="0.4"
      />
      <line
        v-else
        :x1="s.left"
        :x2="s.right"
        :y1="props.object.kind === 'underline' ? s.underlineY : s.strikeY"
        :y2="props.object.kind === 'underline' ? s.underlineY : s.strikeY"
        :stroke="colour"
        :stroke-width="s.thickness"
      />
    </template>
  </g>
</template>
