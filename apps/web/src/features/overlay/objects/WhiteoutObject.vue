<script setup lang="ts">
import { computed } from 'vue'
import type { WhiteoutObject } from '@margin/pdf-core'
import { svgFill } from './svgPaint'

const props = defineProps<{ object: WhiteoutObject }>()

const fill = computed(() => svgFill(props.object.fill))
</script>

<template>
  <!--
    No stroke: a whiteout is a plain opaque cover, and an outline would make
    it read as a drawn shape. What the user sees here is exactly what the
    content stream writes (write/objects/whiteout.ts) -- a filled `re`.
  -->
  <rect
    :x="props.object.rect.x"
    :y="props.object.rect.y"
    :width="props.object.rect.w"
    :height="props.object.rect.h"
    :fill="fill"
  />
</template>
