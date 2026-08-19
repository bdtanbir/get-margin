<script setup lang="ts">
import { computed, watch } from 'vue'
import type { PageState } from '@/stores/document'
import type { FieldValue } from '@margin/pdf-core'
import { useFieldsStore } from '@/stores/fields'
import { useEditsStore } from '@/stores/edits'
import { fieldBox } from './fieldGeometry'
import { fieldCoalesceKey } from './fieldKeys'
import FieldControl from './FieldControl.vue'

const props = defineProps<{ page: PageState; zoom: number }>()

const fields = useFieldsStore()
const edits = useEditsStore()

// Once per source page, cached in the store. A page scrolled past twice
// does not ask twice.
watch(
  () => [props.page.sourceId, props.page.sourceIndex] as const,
  ([sourceId, index]) => { void fields.load(sourceId, index) },
  { immediate: true },
)

const onPage = computed(() => fields.fields(props.page.sourceId, props.page.sourceIndex))

const valueOf = (key: string): FieldValue | undefined => edits.doc.fieldValues[key]

function set(key: string, value: FieldValue): void {
  edits.applyOp({ type: 'setFieldValue', key, value }, 'Fill field', fieldCoalesceKey(key))
}
</script>

<template>
  <!--
    Layer 3, and BELOW ObjectLayer in the stack. A field someone else
    authored is not an object: it is not selectable, draggable, or
    z-ordered, and clicking one focuses it rather than selecting anything.
    Above the objects it would swallow clicks meant for the user's own
    annotations drawn over the form.

    pointer-events-none on the container with each control opting back in,
    the same arrangement PageOverlay uses, so the gaps between fields stay
    transparent to text selection and scrolling.
  -->
  <div v-if="onPage.length" class="pointer-events-none absolute inset-0" data-field-layer>
    <FieldControl
      v-for="f in onPage"
      :key="`${f.key}:${f.exportValue ?? ''}:${f.rect.x},${f.rect.y}`"
      class="pointer-events-auto"
      :field="f"
      :value="valueOf(f.key)"
      :zoom="props.zoom"
      :style="fieldBox(f.rect, props.zoom)"
      @input="(v: FieldValue) => set(f.key, v)"
    />
  </div>
</template>
