<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, watchEffect } from 'vue'
import { getPdfClient } from '@/workers/pdfClient'
import type { TextPatchObject } from '@margin/pdf-core'
import { blockLayout, layoutRuns, patchRuns, runsAdvance, truncateRuns } from '@margin/pdf-core'
import { cssFamily, cssWeight, cssStyle, loadFont, measureText, ASCENT_RATIO } from '@/lib/fonts'
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
 * REMOVE AND REDRAW, as the writer does. The page bitmap still has the
 * original glyphs, so the patch's area is shown as the page looks WITHOUT
 * them -- rendered by the worker from a copy with this page's patched lines
 * taken off -- rather than as an opaque box, which hid whatever the line
 * sat close to (a Turnitin heading on the bottom edge of the logo lost half
 * the logo). Until that picture arrives, and wherever the writer would fall
 * back to covering the line, the box is drawn instead, exactly as before.
 *
 * Geometry is MuPDF PAGE space (top-down), taken from the line's own
 * character quads, so this renders OUTSIDE the overlay's y-flipped root
 * <g> -- the same treatment markup and redaction get.
 */
const props = defineProps<{
  object: TextPatchObject
  /** The file and page the patched line is on, to render it without the line. */
  sourceId?: string | undefined
  sourceIndex?: number | undefined
  /** Every patched line on this page: all are gone in the export, so all are gone here. */
  lines?: readonly number[] | undefined
  /**
   * The page overlay's bottom layer, where the picture of the page without
   * the edited lines goes. Drawn there because removing a line changes the
   * PAGE, beneath every object -- drawn here, beside this patch's text, it
   * hid any other patch's text that ran into this patch's area. Absent (in
   * isolation, in tests) the picture is drawn in place.
   */
  underlay?: SVGGElement | null | undefined
}>()

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

/** Pixels per point of the picture behind the patch: sharp up to about 300%. */
const PREVIEW_SCALE = 3

/** The patch's area as the page looks with its patched lines removed. */
const without = ref<{ href: string; x: number; y: number; width: number; height: number } | undefined>()
let request = 0

function forget(): void {
  if (without.value) URL.revokeObjectURL(without.value.href)
  without.value = undefined
}

watch(
  () => JSON.stringify([props.sourceId, props.sourceIndex, props.lines, cover.value]),
  async () => {
    const at = ++request
    const lines = props.lines ?? []
    const client = getPdfClient()
    if (props.sourceIndex === undefined || lines.length === 0 || typeof document === 'undefined' ||
        typeof client.renderWithoutLines !== 'function') {
      forget()
      return
    }
    const c = cover.value
    const area = { x: c.x, y: c.y, w: c.width, h: c.height }
    const result = await client
      .renderWithoutLines(props.sourceId, props.sourceIndex, [...lines], area, PREVIEW_SCALE)
      .catch(() => null)
    if (at !== request) return
    // Not removed: the export covers this line, so the preview does too.
    const own = [props.object.lineIndex, ...(props.object.paragraph?.lines ?? []).map((l) => l.lineIndex)]
    if (!result || !own.every((i) => result.removed.includes(i))) {
      forget()
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = result.width
    canvas.height = result.height
    const ctx = canvas.getContext('2d')
    if (!ctx) { forget(); return }
    ctx.putImageData(new ImageData(new Uint8ClampedArray(result.rgba), result.width, result.height), 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve))
    if (at !== request || !blob) return
    forget()
    without.value = {
      href: URL.createObjectURL(blob),
      // The picture starts on whole pixels, so its corner is where the
      // worker's rounding put it, not quite where the area began.
      x: Math.floor(area.x * PREVIEW_SCALE) / PREVIEW_SCALE,
      y: Math.floor(area.y * PREVIEW_SCALE) / PREVIEW_SCALE,
      width: result.width / PREVIEW_SCALE,
      height: result.height / PREVIEW_SCALE,
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => { request++; forget() })

/** How the text breaks into lines, or undefined for a one-line patch. See patchRuns.ts. */
const block = computed(() => blockLayout(props.object))

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
  const all = patchRuns(o)
  let runs = all
  let count = [...o.text].length
  // With the letter spacing counted, as the writer counts it: the fit
  // rules are about the ink the line takes up, and a spaced line takes
  // up more. Each run in its own face, as the writer measures it, since a
  // bold word is wider than the same word regular.
  const advance = (): number =>
    runsAdvance(runs, size, o.letterSpacing ?? 0, (run, at) =>
      measureText(run.text, o.fontFamily, at, run))

  // A moved patch overflows whatever `fit` says, because both fit rules
  // measure against `w` -- the width of the line being replaced -- and the
  // text is no longer in that box. The writer does the same.
  if (moved.value || block.value) {
    // Nothing: 'overflow' semantics. A paragraph flows down instead.
  } else if (o.fit === 'shrink') {
    while (size > 4 && advance() > w) size -= 0.5
  } else if (o.fit === 'truncate') {
    while (count > 1 && advance() > w) runs = truncateRuns(all, --count)
  }
  return { size, runs, text: runs.map((r) => r.text).join('') }
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

/**
 * A paragraph patch's lines, each with where it starts -- broken by
 * `layoutRuns`, the function the writer breaks them with, so the screen and
 * the file wrap at the same words.
 */
const blockLines = computed(() => {
  const b = block.value
  if (!b) return []
  const o = props.object
  const size = laid.value.size
  const lines = layoutRuns(laid.value.runs, {
    width: b.width, indent: b.indent, size, spacing: o.letterSpacing ?? 0,
    measure: (run, at) => measureText(run.text, o.fontFamily, at, run),
  })
  // `rect` is the whole paragraph's box; its first line may be indented.
  const left = o.rect.x + dx.value
  return lines.map((runs, k) => ({
    runs,
    x: k === 0 ? left + b.indent : left,
    y: baseline.value + k * b.leading * size,
  }))
})

const background = computed(() => rgb(props.object.background))
const fill = computed(() => rgb(props.object.color))
const family = computed(() => cssFamily(props.object.fontFamily))
/** The style the line was already in, unless the user has overridden it. */
const weight = computed(() => cssWeight(props.object.weight))
const slope = computed(() => cssStyle(props.object.italic))
/** Absent when there is none, for the reason TextObject gives. */
const spacing = computed(() => props.object.letterSpacing || undefined)

/**
 * Pieces in more than one style. A one-style line renders exactly as it
 * always has, as plain text on the <text>; only a mixed line needs tspans.
 */
const mixed = computed(() => laid.value.runs.length > 1 || !!block.value)

/**
 * Every face the runs use, registered so the browser draws the real bold
 * rather than synthesising one from the regular -- which would be a
 * different width from the bold the export embeds.
 */
watchEffect(() => {
  if (!mixed.value || typeof document === 'undefined') return
  for (const run of laid.value.runs) void loadFont(props.object.fontFamily, run).catch(() => {})
})
</script>

<template>
  <g>
    <Teleport v-if="without" :to="props.underlay" :disabled="!props.underlay">
      <image
        :href="without.href"
        :x="without.x"
        :y="without.y"
        :width="without.width"
        :height="without.height"
        preserveAspectRatio="none"
        data-patch-without
      />
    </Teleport>
    <rect
      v-else
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
    <template v-if="block">
      <text
        v-for="(l, k) in blockLines"
        :key="k"
        :x="l.x"
        :y="l.y"
        :fill="fill"
        :font-family="family"
        :font-weight="weight"
        :font-style="slope"
        :font-size="laid.size"
        :letter-spacing="spacing"
        style="white-space: pre"
        data-patch-line
      ><tspan
        v-for="(run, i) in l.runs"
        :key="i"
        :y="l.y - run.rise * laid.size"
        :fill="rgb(run.color)"
        :font-weight="cssWeight(run.weight)"
        :font-style="cssStyle(run.italic)"
        :font-size="laid.size * run.scale"
        data-patch-run
      >{{ run.text }}</tspan></text>
    </template>
    <text
      v-else-if="laid.text !== ''"
      :x="props.object.rect.x + dx"
      :y="baseline"
      :fill="fill"
      :font-family="family"
      :font-weight="weight"
      :font-style="slope"
      :font-size="laid.size"
      :letter-spacing="spacing"
      style="white-space: pre"
    ><template v-if="!mixed">{{ laid.text }}</template><!--
      One tspan per run, each with its own face, size, colour and baseline.
      No x on a tspan: each continues where the previous ended, which is
      how the writer's consecutive Tj calls advance too.
    --><template v-else><tspan
      v-for="(run, i) in laid.runs"
      :key="i"
      :y="baseline - run.rise * laid.size"
      :fill="rgb(run.color)"
      :font-weight="cssWeight(run.weight)"
      :font-style="cssStyle(run.italic)"
      :font-size="laid.size * run.scale"
      data-patch-run
    >{{ run.text }}</tspan></template></text>
  </g>
</template>
