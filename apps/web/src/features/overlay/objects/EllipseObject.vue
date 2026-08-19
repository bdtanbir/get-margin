<script setup lang="ts">
import { computed } from 'vue'
import type { ShapeObject } from '@margin/pdf-core'
import { svgFill, svgStroke } from './svgPaint'

const props = defineProps<{ object: ShapeObject }>()

const cx = computed(() => props.object.rect.x + props.object.rect.w / 2)
const cy = computed(() => props.object.rect.y + props.object.rect.h / 2)
</script>

<template>
  <ellipse
    :cx="cx"
    :cy="cy"
    :rx="Math.abs(props.object.rect.w) / 2"
    :ry="Math.abs(props.object.rect.h) / 2"
    :fill="svgFill(props.object.fill)"
    :stroke="svgStroke(props.object.stroke)"
    :stroke-width="props.object.strokeWidth"
    vector-effect="non-scaling-stroke"
  />
</template>
