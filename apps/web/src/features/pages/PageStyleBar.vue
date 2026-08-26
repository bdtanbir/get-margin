<script setup lang="ts">
import { computed } from 'vue'
import { Ban } from 'lucide-vue-next'
import type { Color } from '@margin/pdf-core'
import IconButton from '@/ui/IconButton.vue'
import { useEditsStore } from '@/stores/edits'
import { usePageSelectionStore } from '@/stores/pageSelection'
import { toHex, fromHex } from '@/features/tools/colorInput'

/**
 * Page properties for whatever is selected in the grid.
 *
 * One property, and deliberately: this briefly carried a text alignment
 * control too, which could only ever reach the text objects the USER added.
 * A PDF stores each glyph run at a fixed coordinate with no line box or
 * column around it, so "centre this page's text" has no defined answer for
 * the document's own content -- nothing in the file says how wide the text
 * was meant to be. A control that looks like it aligns the page while
 * silently only aligning your own additions is worse than no control, and
 * the object inspector already offers Align on a selected text box, which
 * is where that choice actually belongs.
 */
const edits = useEditsStore()
const selection = usePageSelectionStore()

const pageIds = computed(() => selection.selected)

/**
 * The one colour shared by everything selected, or undefined when they
 * disagree. A swatch showing the first page's colour for a mixed selection
 * would be a claim about the others that is not true -- and the next click
 * would repaint them all to a colour the user was only shown as a
 * description of one.
 */
const background = computed(() => {
  const values = pageIds.value.map((id) => edits.doc.pages[id]?.background)
  const first = values[0]
  if (first === undefined) return undefined
  const same = (a?: Color, b?: Color): boolean =>
    a && b ? a.every((n, i) => n === b[i]) : a === b
  return values.every((v) => same(v, first)) ? first : undefined
})

/**
 * Enabled whenever ANY selected page is painted, not only when they agree:
 * a mixed selection has something to remove, and `background` is undefined
 * there precisely because they disagree.
 */
const canClear = computed(() => pageIds.value.some((id) => !!edits.doc.pages[id]?.background))

/**
 * A colour input emits an `input` per pixel of pointer travel and one
 * `change` when it is released. Without coalescing, dragging across the
 * picker is one undo step per frame -- the same reason Inspector.vue holds a
 * transaction open across the gesture rather than using withTransaction,
 * whose callback is synchronous and would close before the next event.
 */
let dragging = false

function paint(color: Color | null): void {
  const ids = pageIds.value
  if (ids.length === 0) return
  for (const pageId of ids) {
    edits.applyOp({ type: 'setPageBackground', pageId, color }, 'Page background')
  }
}

function onColorInput(e: Event): void {
  if (!dragging) {
    dragging = true
    edits.beginTransaction('Page background')
  }
  paint(fromHex((e.target as HTMLInputElement).value))
}

function onColorCommit(): void {
  if (!dragging) return
  dragging = false
  edits.endTransaction()
}

function clearBackground(): void {
  // Its own transaction: removing a background is one action, and it must
  // not be swallowed into a colour drag that happened before it.
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
        :value="toHex(background ?? null)"
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
  </div>
</template>
