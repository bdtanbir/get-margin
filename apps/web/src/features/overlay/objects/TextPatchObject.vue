<script setup lang="ts">
import { computed } from 'vue'
import type { TextPatchObject } from '@margin/pdf-core'
import { cssFamily, cssWeight, cssStyle, measureText, ASCENT_RATIO } from '@/lib/fonts'
import { rgb } from './svgPaint'

/**
 * What a text patch looks like on screen.
 *
 * This did not exist, and its absence was the bug: `ObjectLayer`'s kind
 * table had no entry for `textPatch`, and an unregistered kind renders
 * nothing. So replacing a line changed the document, survived undo/redo,
 * and came out correctly in the export -- while the viewer went on showing
 * the original text, with no indication anything had happened.
 *
 * It mirrors `write/objects/patch.ts` deliberately, including the bleed and
 * the fit rules, because the whole point is to show what the export will
 * produce. Where the two could drift they share constants: `ASCENT_RATIO`
 * and `measureText` come from `lib/fonts.ts`, which the writer's own
 * comment names as the other half of that pair.
 *
 * COVER AND REDRAW, not removal -- the same as the writer. The original
 * glyphs are still in the page bitmap underneath; this paints over them.
 * That distinction matters and the privacy page depends on it: hiding text
 * is not redaction, and redaction is a separate tool that removes.
 *
 * Geometry is MuPDF PAGE space (top-down), taken from the line's own
 * character quads, so this renders OUTSIDE the overlay's y-flipped root
 * <g> -- the same treatment markup and redaction get.
 */
const props = defineProps<{ object: TextPatchObject }>()

/**
 * How far the replacement has been dragged from the line it replaces.
 *
 * ADDED to y here, where the writer SUBTRACTS it: this component renders
 * outside the overlay's y-flipped root, in page space, which is already
 * top-down -- while a content stream is bottom-up. Two opposite signs for
 * the same movement, and `TextPatchObject.test.ts` holds them together.
 *
 * It moves the TEXT only. The cover below keeps the un-offset rect, because
 * the document's own glyphs are still under it and dragging the cover along
 * would uncover them.
 */
const dx = computed(() => props.object.offset?.dx ?? 0)
const dy = computed(() => props.object.offset?.dy ?? 0)
const moved = computed(() => dx.value !== 0 || dy.value !== 0)

/** Matches the writer: glyph quads sit tight against the ink, so cover a little wider. */
const bleed = computed(() => Math.max(1, props.object.rect.h * 0.12))

const cover = computed(() => {
  const { x, y, w, h } = props.object.rect
  const b = bleed.value
  return { x: x - b, y: y - b, width: w + b * 2, height: h + b * 2 }
})

/**
 * Size and text after the fit rule, resolved the way the writer resolves
 * them.
 *
 * `shrink` only ever shrinks -- growing text to fill the box would be a
 * different edit than the one asked for. `overflow` deliberately does
 * nothing: the user chose to let it run past, and nothing reflows around
 * it.
 */
const laid = computed(() => {
  const o = props.object
  const { w, h } = o.rect
  let size = o.fontSize > 0 ? o.fontSize : h * 0.8
  let text = o.text
  const advance = (): number => measureText(text, o.fontFamily, size, o)

  // A moved patch overflows whatever `fit` says, because both fit rules
  // measure against `w` -- the width of the line being replaced -- and the
  // text is no longer in that box. The writer does the same.
  if (moved.value) {
    // Nothing: 'overflow' semantics.
  } else if (o.fit === 'shrink') {
    while (size > 4 && advance() > w) size -= 0.5
  } else if (o.fit === 'truncate') {
    while (text.length > 1 && advance() > w) text = text.slice(0, -1)
  }
  return { size, text }
})

/**
 * The baseline, in page space.
 *
 * THE LINE'S OWN, when the patch carries it. The writer sits the
 * replacement on the baseline it re-extracts from the page -- not on one
 * derived from the box and the font size -- because how far a baseline sits
 * above the bottom of a glyph box depends on the font's descender, and the
 * derived figure misses it by a couple of points at body size and about
 * five at 24pt.
 *
 * Deriving it here was survivable while the size was fixed: the error was
 * fixed too, so the previewed text sat a little high and stayed there. With
 * the size editable the error becomes a function of it -- the preview would
 * climb the page as you increased the size while the exported text did not
 * move at all.
 *
 * The fallback is for patches stored before the baseline was recorded. It
 * is the old approximation, kept deliberately: those patches previewed at
 * that height yesterday and moving them today would look like a bug in
 * whatever the user had already laid out.
 */
const baseline = computed(() =>
  (props.object.baseline ?? props.object.rect.y + laid.value.size * ASCENT_RATIO) + dy.value,
)

const background = computed(() => rgb(props.object.background))
const fill = computed(() => rgb(props.object.color))
const family = computed(() => cssFamily(props.object.fontFamily))
/** The style the line was already in, unless the user has overridden it. */
const weight = computed(() => cssWeight(props.object.bold))
const slope = computed(() => cssStyle(props.object.italic))
</script>

<template>
  <g>
    <rect
      :x="cover.x"
      :y="cover.y"
      :width="cover.width"
      :height="cover.height"
      :fill="background"
    />
    <!--
      No scale(1,-1) here, unlike TextObject: that one lives inside the
      y-flipped root and has to undo the flip per line. This renders outside
      it, in a space that is already top-down, so the glyphs are the right
      way up as written.
    -->
    <text
      v-if="laid.text !== ''"
      :x="props.object.rect.x + dx"
      :y="baseline"
      :fill="fill"
      :font-family="family"
      :font-weight="weight"
      :font-style="slope"
      :font-size="laid.size"
      style="white-space: pre"
    >{{ laid.text }}</text>
  </g>
</template>
