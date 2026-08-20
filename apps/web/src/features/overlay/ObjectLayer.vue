<script setup lang="ts">
import { computed } from 'vue'
import type { EditObject } from '@margin/pdf-core'
import { COMPONENTS } from './objects/registry'

const props = defineProps<{ object: EditObject }>()

const component = computed(() => COMPONENTS[props.object.kind])

/**
 * Object-local rotation about its own centre. Page rotation is NOT applied
 * here -- it is already on the overlay's root <g>.
 */
const transform = computed(() => {
  const { rect, rotation } = props.object
  if (!rotation) return undefined
  return `rotate(${rotation} ${rect.x + rect.w / 2} ${rect.y + rect.h / 2})`
})
</script>

<template>
  <g
    v-if="component"
    :data-object-id="props.object.id"
    :transform="transform"
    :opacity="props.object.opacity"
    class="pointer-events-auto"
  >
    <component :is="component" :object="props.object" />
  </g>
</template>
