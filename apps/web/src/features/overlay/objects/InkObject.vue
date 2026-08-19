<script setup lang="ts">
import { computed } from 'vue'
import type { InkObject } from '@margin/pdf-core'
import { rgb } from './svgPaint'

const props = defineProps<{ object: InkObject }>()

/**
 * One <path> per stroke, in raw PDF coordinates. Round caps and joins match
 * how a native Ink annotation's /AP is drawn, so the preview and the
 * exported annotation read the same at the ends and corners.
 */
const paths = computed(() =>
  props.object.strokes.map((flat) => {
    const parts: string[] = []
    for (let i = 0; i + 1 < flat.length; i += 2) {
      parts.push(`${parts.length === 0 ? 'M' : 'L'} ${flat[i]} ${flat[i + 1]}`)
    }
    return parts.join(' ')
  }).filter((d) => d.length > 0),
)

const stroke = computed(() => rgb(props.object.color))
</script>

<template>
  <path
    v-for="(d, i) in paths"
    :key="i"
    :d="d"
    fill="none"
    :stroke="stroke"
    :stroke-width="props.object.strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    vector-effect="non-scaling-stroke"
  />
</template>
