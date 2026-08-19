<script setup lang="ts">
import { computed } from 'vue'
import type { ShapeObject } from '@margin/pdf-core'
import { svgStroke } from './svgPaint'

const props = defineProps<{ object: ShapeObject }>()

/**
 * These two must stay equal to ARROWHEAD_LEN / ARROWHEAD_HALF_WIDTH in
 * pdf-core/src/write/objects/shape.ts. Preview and export drawing different
 * arrowheads is the kind of mismatch nobody notices until a printed
 * document does not match the screen.
 */
const HEAD_LEN = 12
const HEAD_HALF_WIDTH = 5

const geometry = computed(() => {
  const { x, y, w, h } = props.object.rect
  const x2 = x + w
  const y2 = y + h
  const len = Math.hypot(w, h) || 1
  const ux = w / len
  const uy = h / len
  const bx = x2 - ux * HEAD_LEN
  const by = y2 - uy * HEAD_LEN
  const px = -uy * HEAD_HALF_WIDTH
  const py = ux * HEAD_HALF_WIDTH
  return {
    shaft: { x1: x, y1: y, x2: bx, y2: by },
    head: `M ${x2} ${y2} L ${bx + px} ${by + py} L ${bx - px} ${by - py} Z`,
  }
})
</script>

<template>
  <g>
    <line
      :x1="geometry.shaft.x1"
      :y1="geometry.shaft.y1"
      :x2="geometry.shaft.x2"
      :y2="geometry.shaft.y2"
      :stroke="svgStroke(props.object.stroke)"
      :stroke-width="props.object.strokeWidth"
      vector-effect="non-scaling-stroke"
    />
    <!-- Head filled with the STROKE colour, matching the writer. -->
    <path :d="geometry.head" :fill="svgStroke(props.object.stroke)" />
  </g>
</template>
