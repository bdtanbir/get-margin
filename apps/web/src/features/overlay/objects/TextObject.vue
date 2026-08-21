<script setup lang="ts">
import { computed } from 'vue'
import type { TextObject } from '@margin/pdf-core'
import { cssFamily, cssWeight, cssStyle, measureText, ASCENT_RATIO, LINE_HEIGHT } from '@/lib/fonts'
import { rgb } from './svgPaint'

const props = defineProps<{ object: TextObject }>()

/**
 * One <text> per line, positioned exactly as write/objects/text.ts positions
 * it: baseline ASCENT_RATIO below the box top, successive lines LINE_HEIGHT
 * apart. The two share those constants (lib/fonts.ts re-exports them) so
 * preview and export cannot drift.
 */
const lines = computed(() => {
  const o = props.object
  const { x, y, w, h } = o.rect
  return o.text.split('\n').map((text, i) => {
    const baseline = y + h - o.fontSize * ASCENT_RATIO - i * o.fontSize * LINE_HEIGHT
    const advance = measureText(text, o.fontFamily, o.fontSize, o)
    const offset =
      o.align === 'center' ? (w - advance) / 2 : o.align === 'right' ? w - advance : 0
    return { text, x: x + offset, baseline }
  })
})

const fill = computed(() => rgb(props.object.color))
const family = computed(() => cssFamily(props.object.fontFamily))
/**
 * The real files are registered under this family at these descriptors, so
 * asking for them here picks up those outlines rather than the browser's
 * synthesised bold or oblique -- which would be a different shape and,
 * worse, a different width from the one `measureText` just returned.
 */
const weight = computed(() => cssWeight(props.object.bold))
const slope = computed(() => cssStyle(props.object.italic))
</script>

<template>
  <!--
    The overlay's root <g> carries a y-flip so PDF-space geometry lands
    unmodified. Glyphs would be flipped by it too, so each line undoes the
    flip locally with scale(1,-1) and negates its own y. Doing it per line
    rather than on a wrapper keeps every coordinate below in raw PDF space.
  -->
  <text
    v-for="(l, i) in lines"
    :key="i"
    :x="l.x"
    :y="-l.baseline"
    transform="scale(1,-1)"
    :fill="fill"
    :font-family="family"
    :font-weight="weight"
    :font-style="slope"
    :font-size="props.object.fontSize"
    style="white-space: pre"
  >{{ l.text }}</text>
</template>
