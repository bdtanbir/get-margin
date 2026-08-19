<script setup lang="ts">
import { computed, type Component } from 'vue'
import type { EditObject, ObjectKind } from '@margin/pdf-core'
import RectObject from './objects/RectObject.vue'
import EllipseObject from './objects/EllipseObject.vue'
import LineObject from './objects/LineObject.vue'
import ArrowObject from './objects/ArrowObject.vue'

const props = defineProps<{ object: EditObject }>()

/**
 * Kind -> component. Tasks 29-35 register their own here. An unregistered
 * kind renders nothing rather than throwing: a half-broken overlay is
 * recoverable, and the EXPORT path is where an unknown kind must fail loudly
 * (see WRITERS in pdf-core/src/write/index.ts).
 *
 * Values are typed `Component`, not their concrete component types.
 * `<component :is>` resolves on a runtime discriminant, so vue-tsc cannot
 * narrow `props.object` (the whole `EditObject` union) to the one variant
 * the resolved component's prop declares -- a concretely-typed table makes
 * the `:object` binding below a hard type error rather than a checked one.
 * Each renderer still checks its own props at its definition site; what this
 * table is responsible for is the mapping, and `Partial<Record<ObjectKind,
 * ...>>` is what keeps a typo'd or retired kind key from compiling.
 */
const COMPONENTS: Partial<Record<ObjectKind, Component>> = {
  rect: RectObject,
  ellipse: EllipseObject,
  line: LineObject,
  arrow: ArrowObject,
}

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
