<script setup lang="ts">
import { computed } from 'vue'
import type { ShapeObject } from '@margin/pdf-core'

const props = defineProps<{ object: ShapeObject }>()

/** `[0.2,0.4,1]` (MuPDF's 0..1 range) -> `rgb(51,102,255)` for CSS/SVG. */
const rgb = (c: [number, number, number] | null): string =>
  c ? `rgb(${c.map((n) => Math.round(n * 255)).join(',')})` : 'none'

const fill = computed(() => rgb(props.object.fill))
const stroke = computed(() => rgb(props.object.stroke))
</script>

<template>
  <!--
    y is the object's PDF-space BOTTOM edge; the root <g>'s y-flip means an
    SVG <rect> drawn at that y with positive height extends upward on screen,
    exactly as PDF space intends. No manual flip here -- that is the point
    of putting the transform on the root group.
  -->
  <rect
    :x="props.object.rect.x"
    :y="props.object.rect.y"
    :width="props.object.rect.w"
    :height="props.object.rect.h"
    :fill="fill"
    :stroke="stroke"
    :stroke-width="props.object.strokeWidth"
    vector-effect="non-scaling-stroke"
  />
</template>
