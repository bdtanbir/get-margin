<script setup lang="ts">
import { computed } from 'vue'
import { AlignLeft, AlignCenter, AlignRight, Ban } from 'lucide-vue-next'
import type { Color, TextObject } from '@margin/pdf-core'
import IconButton from '@/ui/IconButton.vue'
import { useEditsStore } from '@/stores/edits'
import { usePageSelectionStore } from '@/stores/pageSelection'
import { toHex, fromHex } from '@/features/tools/colorInput'

/**
 * Page styling for whatever is selected in the grid.
 *
 * TWO CONTROLS THAT WORK DIFFERENTLY, deliberately, because the two things
 * they change are not the same kind of thing.
 *
 * Background is a PAGE PROPERTY: it is stored on the page entry, it survives
 * an export as a fill painted under the page's content, and the swatch shows
 * what the page currently is.
 *
 * Alignment is an ACTION on the text objects sitting on those pages. It is
 * NOT stored on the page, and that is the honest version: this application
 * cannot reflow a PDF's own text -- the glyphs in the source file are placed
 * at fixed coordinates, and there is no paragraph to re-align. What it can
 * align is the text the USER added. Storing a page-level alignment as well
 * would be a second copy of that state, free to disagree with the objects
 * the moment anyone touched the inspector's own Align field.
 *
 * So the pressed state is DERIVED: a button is on when every text object on
 * the selection already agrees, and none is on when they disagree -- which
 * is how an alignment control in a word processor behaves and means the bar
 * can never claim something the document does not say.
 */
const edits = useEditsStore()
const selection = usePageSelectionStore()

const pageIds = computed(() => selection.selected)

const plural = computed(() => (pageIds.value.length === 1 ? 'page' : 'pages'))

/** Every user-added text object sitting on the selected pages. */
const textObjects = computed<TextObject[]>(() => {
  const pages = new Set(pageIds.value)
  return Object.values(edits.doc.objects).filter(
    (o): o is TextObject => o.kind === 'text' && pages.has(o.pageId) && !o.locked,
  )
})

/**
 * The one value shared by everything selected, or undefined when they
 * disagree. Used for both controls: a mixed selection should show no
 * opinion rather than the first page's, which would be a lie about the rest.
 */
function shared<T>(values: T[], same: (a: T, b: T) => boolean): T | undefined {
  const first = values[0]
  if (first === undefined) return undefined
  return values.every((v) => same(v, first)) ? first : undefined
}

const background = computed(() =>
  shared(
    pageIds.value.map((id) => edits.doc.pages[id]?.background),
    (a, b) => (a && b ? a.every((n, i) => n === b[i]) : a === b),
  ),
)

const align = computed(() =>
  shared(textObjects.value.map((o) => o.align), (a, b) => a === b),
)

/** Nothing to align is a disabled control, not a button that quietly does nothing. */
const canAlign = computed(() => textObjects.value.length > 0)

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

function setAlign(value: 'left' | 'center' | 'right'): void {
  const objects = textObjects.value
  if (objects.length === 0) return
  // One transaction for the whole click: aligning a page of text is ONE
  // action to the user, so it is one Ctrl+Z however many objects it moved.
  edits.withTransaction('Align text', () => {
    for (const o of objects) {
      edits.applyOp({ type: 'updateObject', id: o.id, patch: { align: value } }, 'Align')
    }
  })
}

const ALIGNMENTS = [
  { value: 'left', label: 'Align text left', icon: AlignLeft },
  { value: 'center', label: 'Align text centre', icon: AlignCenter },
  { value: 'right', label: 'Align text right', icon: AlignRight },
] as const
</script>

<template>
  <div
    data-page-style-bar
    class="shrink-0 border-b border-border px-3 pb-2 text-[13px]"
  >
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

    <div class="flex min-h-8 items-center gap-2">
      <span id="page-align-label" class="mr-auto text-text-muted">Text align</span>
      <!--
        Grouped and labelled, so a screen reader reaching the second button
        still knows what the three of them are for -- "Text align" is a
        heading a sighted user reads once and a linear reader would otherwise
        have passed several controls ago.
      -->
      <div
        role="group"
        aria-labelledby="page-align-label"
        class="flex items-center gap-0.5"
      >
        <IconButton
          v-for="a in ALIGNMENTS"
          :key="a.value"
          size="sm"
          :label="a.label"
          :active="align === a.value"
          :disabled="!canAlign"
          :data-align="a.value"
          @click="setAlign(a.value)"
        >
          <component :is="a.icon" :size="15" :stroke-width="1.5" />
        </IconButton>
      </div>
    </div>

    <!--
      Said once, where the control is, rather than left for the user to
      discover by clicking a dead button. A PDF's own text is placed glyph by
      glyph at fixed coordinates -- there is no paragraph to re-align -- so
      this control reaches the text the user added and nothing else.
    -->
    <p v-if="!canAlign" data-align-notice class="pt-1 text-[11px] text-text-subtle">
      Alignment applies to text you add. There is none on the selected {{ plural }} yet.
    </p>
  </div>
</template>
