<script setup lang="ts">
import type { ShapeObject } from '@margin/pdf-core'
import { svgStroke } from './svgPaint'

const props = defineProps<{ object: ShapeObject }>()
</script>

<template>
  <!--
    A line's rect is DIRECTED (see directedRect in @margin/transform): w/h
    carry the drag's sign, so the end point is x+w, y+h and must not be
    normalised. Rendering from a normalised rect would silently redraw a
    down-left drag as an up-right one.
  -->
  <line
    :x1="props.object.rect.x"
    :y1="props.object.rect.y"
    :x2="props.object.rect.x + props.object.rect.w"
    :y2="props.object.rect.y + props.object.rect.h"
    :stroke="svgStroke(props.object.stroke)"
    :stroke-width="props.object.strokeWidth"
    vector-effect="non-scaling-stroke"
  />
</template>
