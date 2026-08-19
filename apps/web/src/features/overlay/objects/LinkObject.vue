<script setup lang="ts">
import type { LinkObject } from '@margin/pdf-core'

const props = defineProps<{ object: LinkObject }>()
</script>

<template>
  <!--
    EDITOR-ONLY affordance. fz_link has no /AP -- link hotspots are invisible
    by design in the PDF spec, and write/objects/link.ts writes nothing into
    the content stream (link.test.ts asserts the exported page is
    pixel-identical). Without this the user would be placing a rectangle they
    cannot see, so the editor draws one; the exported file has none.

    Dashed rather than solid so it reads as a boundary rather than a drawn
    shape, which is the honest signal: nothing here is printed.
  -->
  <g>
    <rect
      :x="props.object.rect.x"
      :y="props.object.rect.y"
      :width="props.object.rect.w"
      :height="props.object.rect.h"
      fill="rgb(59,130,246)"
      fill-opacity="0.08"
      stroke="rgb(59,130,246)"
      stroke-width="1"
      stroke-dasharray="4 3"
      vector-effect="non-scaling-stroke"
    />
    <title>{{ props.object.uri }}</title>
  </g>
</template>
