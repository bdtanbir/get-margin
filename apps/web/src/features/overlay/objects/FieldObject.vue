<script setup lang="ts">
import { computed } from 'vue'
import type { FieldObject } from '@margin/pdf-core'

const props = defineProps<{ object: FieldObject }>()

const round = computed(() => props.object.fieldType === 'radio')

/**
 * A short type marker, so a page of empty boxes is legible without
 * selecting each one. Text fields get nothing: an unlabelled box IS a text
 * field, and marking the common case adds noise to every form.
 */
const marker = computed(() => ({
  text: '', checkbox: '', radio: '', signature: 'Sign',
  dropdown: 'List', listbox: 'List',
}[props.object.fieldType]))
</script>

<template>
  <!--
    EDITOR-ONLY chrome, like LinkObject's. What the exported file shows is
    the widget's own appearance -- a border from /MK /BC, and for a button a
    two-state /AP stream -- none of which is drawn here. The editor needs
    the box visible while it is being positioned; the export must not
    inherit the editor's idea of what a field looks like.

    Dashed, so it reads as a boundary rather than a drawn shape.
  -->
  <g>
    <rect
      :x="props.object.rect.x"
      :y="props.object.rect.y"
      :width="props.object.rect.w"
      :height="props.object.rect.h"
      :rx="round ? props.object.rect.w / 2 : 2"
      fill="rgb(99,102,241)"
      fill-opacity="0.08"
      stroke="rgb(99,102,241)"
      stroke-width="1"
      stroke-dasharray="4 3"
      vector-effect="non-scaling-stroke"
    />
    <!--
      Drawn INSIDE the flipped root <g>, so the text would render upside
      down without a local flip about its own baseline.
    -->
    <text
      v-if="marker"
      :x="props.object.rect.x + 3"
      :y="props.object.rect.y + props.object.rect.h - 4"
      :transform="`scale(1,-1) translate(0,${-2 * (props.object.rect.y + props.object.rect.h - 4)})`"
      font-size="8"
      fill="rgb(99,102,241)"
    >{{ marker }}</text>
    <title>{{ props.object.name }}</title>
  </g>
</template>
