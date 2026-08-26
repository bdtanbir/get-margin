<script setup lang="ts">
import { computed, ref } from 'vue'
import { Ban } from 'lucide-vue-next'
import type { Color } from '@margin/pdf-core'
import IconButton from '@/ui/IconButton.vue'
import { useEditsStore } from '@/stores/edits'
import { usePageSelectionStore } from '@/stores/pageSelection'
import { useViewportStore } from '@/stores/viewport'
import { toHex, fromHex } from '@/features/tools/colorInput'
import { detectPaper, applyTint, reachable, isNeutral, sameColor, WHITE } from './paperColor'

/**
 * Page properties for whatever is selected in the grid.
 *
 * THE SWATCH SHOWS THE PAPER, NOT THE STORED COLOUR, and that distinction is
 * the whole of this component.
 *
 * A background is MULTIPLIED over the page rather than replacing it, because
 * that is the only form that survives a page which paints its own opaque
 * white (see applyPageBackgrounds). So what the reader sees is `paper x
 * stored`. On a plain white page those are the same number, which is why
 * showing the stored value looked correct for as long as every test page was
 * white -- and why it was wrong on a document you exported a background onto
 * and reopened, where the colour is baked into the file and NOTHING is
 * stored. There the swatch showed black while the page was plainly red.
 *
 * Reading the paper off the page's own render answers both cases with one
 * rule. What is stored stays exactly the colour the user picked: an earlier
 * version divided the detected paper back out so a second pick would land on
 * itself, and that assumes a page has ONE paper colour, which real pages do
 * not -- see paperColor.ts for the document that disproved it and the magenta
 * card it produced.
 */
const edits = useEditsStore()
const selection = usePageSelectionStore()
const vp = useViewportStore()

const pageIds = computed(() => selection.selected)

/**
 * The one value shared by everything selected, or undefined when they
 * disagree. A swatch showing the first page's colour for a mixed selection
 * would be a claim about the others that is not true -- and the next pick
 * would repaint them all from a starting point that only described one.
 */
function shared(values: Color[]): Color | undefined {
  const first = values[0]
  if (!first) return undefined
  return values.every((v) => sameColor(v, first)) ? first : undefined
}

const tintOf = (id: string): Color => edits.doc.pages[id]?.background ?? WHITE

/** What each page's paper would be with no background of ours on it. */
const sourcePaper = computed(() => shared(pageIds.value.map((id) => detectPaper(vp.bitmapFor(id)))))

/** What the reader is actually looking at right now. */
const paper = computed(() => {
  const values = pageIds.value.map((id) => applyTint(detectPaper(vp.bitmapFor(id)), tintOf(id)))
  return shared(values)
})

/**
 * Enabled whenever ANY selected page carries a background, not only when they
 * agree: a mixed selection has something to remove, and the shared values
 * above are undefined there precisely because they disagree.
 */
const canClear = computed(() => pageIds.value.some((id) => !!edits.doc.pages[id]?.background))

/**
 * The colour last asked for, kept only so the notice below can tell whether
 * the page could actually be made it. A ref rather than a plain variable
 * because the notice renders from it.
 */
const asked = ref<Color | undefined>(undefined)

/**
 * True when the last pick could not be reached. Multiply only ever darkens,
 * so a page whose paper is already coloured can be taken further down but
 * never back up -- there is no factor that turns a red sheet blue. Saying so
 * is the alternative to silently producing mud, which is what this did.
 */
const unreachable = computed(() => {
  const want = asked.value
  const base = sourcePaper.value
  return !!want && !!base && !reachable(want, base)
})

/**
 * A colour input emits an `input` per pixel of pointer travel and one
 * `change` when it is released. Without coalescing, dragging across the
 * picker is one undo step per frame -- the same reason Inspector.vue holds a
 * transaction open across the gesture rather than using withTransaction,
 * whose callback is synchronous and would close before the next event.
 */
let dragging = false

function paint(target: Color | null): void {
  const ids = pageIds.value
  if (ids.length === 0) return
  // The colour itself, unadjusted. See the header: the page is not guaranteed
  // to have one paper colour, so there is nothing sound to adjust it against.
  const color = target === null || isNeutral(target) ? null : target
  for (const pageId of ids) {
    edits.applyOp({ type: 'setPageBackground', pageId, color }, 'Page background')
  }
}

function onColorInput(e: Event): void {
  if (!dragging) {
    dragging = true
    edits.beginTransaction('Page background')
  }
  const target = fromHex((e.target as HTMLInputElement).value)
  asked.value = target
  paint(target)
}

function onColorCommit(): void {
  if (!dragging) return
  dragging = false
  edits.endTransaction()
}

function clearBackground(): void {
  // Its own transaction: removing a background is one action, and it must
  // not be swallowed into a colour drag that happened before it.
  asked.value = undefined
  edits.withTransaction('Remove page background', () => paint(null))
}
</script>

<template>
  <div
    data-page-style-bar
    class="shrink-0 border-b border-border pb-3 text-[13px]"
  >
    <h2 class="pb-1 text-[13px] font-medium text-text">
      {{ pageIds.length === 1 ? 'Page' : `${pageIds.length} pages` }}
    </h2>

    <div class="flex min-h-8 items-center gap-2">
      <label for="page-background" class="mr-auto text-text-muted">Background</label>
      <!--
        No `title` on the swatch and no tooltip: the label beside it is
        associated by `for`/`id`, which is what a screen reader reads and
        what a pointer user can click to open the picker.
      -->
      <input
        id="page-background"
        data-page-background-input
        type="color"
        class="size-8 rounded-control border border-border bg-surface-sunken"
        :value="toHex(paper ?? null)"
        @input="onColorInput"
        @change="onColorCommit"
        @blur="onColorCommit"
      />
      <IconButton
        size="sm"
        label="Remove page background"
        data-clear-page-background
        :disabled="!canClear"
        @click="clearBackground"
      >
        <Ban :size="15" :stroke-width="1.5" />
      </IconButton>
    </div>

    <!--
      Shown only when it applies, which on an ordinary white page is never.
      The alternative was letting an unreachable pick land as a muddy
      combination of the two colours and leaving the user to work out why.
    -->
    <p v-if="unreachable" data-unreachable-notice class="pt-1 text-[11px] text-text-subtle">
      This page already has a coloured background, and a background can only
      darken what is there. To reach a lighter colour, open the original file.
    </p>
  </div>
</template>
