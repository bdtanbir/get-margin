<script setup lang="ts">
import { computed } from 'vue'
import type { ShapeObject } from '@margin/pdf-core'
import { svgFill, svgStroke } from './svgPaint'

const props = defineProps<{ object: ShapeObject }>()

const fill = computed(() => svgFill(props.object.fill))
const stroke = computed(() => svgStroke(props.object.stroke))
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
