<script setup lang="ts">
import { ref, watch, onMounted, nextTick } from 'vue'
import { ChevronUp, ChevronDown, X, Replace } from 'lucide-vue-next'
import IconButton from '@/ui/IconButton.vue'
import { useFindStore } from '@/stores/find'
import { useViewportStore } from '@/stores/viewport'
import { useEditsStore } from '@/stores/edits'
import { useViewportStore as useVp } from '@/stores/viewport'
import { DEFAULT_FAMILY } from '@/lib/fonts'
import { sampleBackground } from '@/features/patch/sampleBackground'
import { patchOnLine } from '@/features/patch/linePatch'
import { buildReplacements } from './buildReplacements'
import type { PageMatch } from '@/stores/find'

const emit = defineEmits<{ close: [] }>()

const find = useFindStore()
const vp = useViewportStore()
const edits = useEditsStore()

const replacement = ref('')
const showReplace = ref(false)
const report = ref('')

/**
 * Where a match's page sits in the document AS DISPLAYED.
 *
 * The worker searches the source document, so a match carries a SOURCE
 * page index. The viewport anchors on display position, and the two
 * diverge the moment a page is reordered, deleted, or a second file merged
 * in -- so jumping straight to `match.page` would scroll somewhere the
 * match is not. Returns -1 when the page carrying the match has been
 * deleted, which is a real state and not an error.
 */
function displayIndexOf(sourceIndex: number): number {
  // The EDIT store's page entries, not the document store's: they carry
  // the same sourceIndex, and the document store's PageState additionally
  // needs a registered source to build geometry -- so reading it here
  // would return nothing for a page whose source is still loading.
  return edits.doc.pageOrder.findIndex(
    (id) => edits.doc.pages[id]?.sourceIndex === sourceIndex,
  )
}
const input = ref<HTMLInputElement | null>(null)

onMounted(async () => {
  await nextTick()
  input.value?.focus()
  input.value?.select()
})

/**
 * Debounced, because every keystroke would otherwise scan the whole
 * document. The store discards stale responses on its own, so this is
 * about work rather than correctness.
 */
let timer: ReturnType<typeof setTimeout> | undefined
watch(
  () => [find.query, find.caseSensitive, find.wholeWord],
  () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void find.search(), 180)
  },
)

// Following the current match is the whole point of next/previous.
watch(() => find.active, (match) => {
  if (!match) return
  const index = displayIndexOf(match.page)
  // Navigation, not a position report: the whole point of next/previous is
  // that the viewport follows.
  if (index >= 0) vp.goToPage(index)
})

/** The edit-document page id for a source page, or undefined if it is gone. */
function pageIdFor(sourcePage: number): string | undefined {
  return edits.doc.pageOrder.find(
    (id) => edits.doc.pages[id]?.sourceIndex === sourcePage,
  )
}

/**
 * The background behind a match's line, if that page has been rendered.
 *
 * Replace-all reaches pages the user has never scrolled to, which have no
 * bitmap -- so most replacements will report zero confidence, and the
 * summary says how many rather than pretending they were all sampled.
 */
function sampleFor(sourcePage: number, match: PageMatch) {
  const pageId = pageIdFor(sourcePage)
  if (!pageId) return undefined
  const bitmap = useVp().bitmapFor(pageId)
  if (!bitmap) return undefined

  const xs = match.quads.flatMap((q) => [q[0], q[2], q[4], q[6]])
  const ys = match.quads.flatMap((q) => [q[1], q[3], q[5], q[7]])
  return sampleBackground(
    bitmap,
    {
      x: Math.min(...xs), y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
    },
    bitmap.scale,
  )
}

function apply(matches: PageMatch[], label: string): void {
  if (matches.length === 0) return
  const plan = buildReplacements(matches, replacement.value, {
    pageIdFor,
    sampleFor,
    /**
     * Whether the user has already edited, styled or moved this line.
     *
     * The same lookup `PatchEditor` and `SelectionToolbar` use, so all
     * three agree about which patch covers a line -- a second answer would
     * let them add one each, which is exactly the duplicate that made a
     * replace over an edited line discard the edit.
     */
    patchOnLine: (pageId, lineIndex) =>
      patchOnLine(Object.values(edits.doc.objects), pageId, lineIndex),
    fontFamily: DEFAULT_FAMILY,
    nextZ: () => edits.nextZ(),
  })

  // ONE history entry for the whole run: replacing forty occurrences is
  // one decision and should cost one Cmd+Z.
  edits.withTransaction(label, () => {
    for (const patch of plan.patches) {
      edits.applyOp({ type: 'addObject', object: patch }, label)
    }
    // UPDATES, not additions. A line that already had a patch gets the
    // replacement folded into it: adding a second one would leave two
    // covers on the line, and whichever the writer reached last would
    // silently discard the other.
    for (const { id, text } of plan.updates) {
      edits.applyOp({ type: 'updateObject', id, patch: { text } }, label)
    }
  })

  // The count the user was shown has to reconcile with what happened.
  const parts = [`Replaced ${matches.length - plan.skipped.length} of ${matches.length}`]
  if (plan.skipped.length) parts.push(`${plan.skipped.length} skipped`)
  if (plan.lowConfidence) {
    parts.push(`${plan.lowConfidence} may show a visible mark`)
  }
  report.value = parts.join(' · ')

  void find.search()
}

function replaceOne(): void {
  const match = find.active
  if (match) apply([match], 'Replace')
}

function replaceAll(): void {
  apply([...find.matches], 'Replace all')
}

function close(): void {
  find.clear()
  emit('close')
}
</script>

<template>
  <!--
    A panel rather than a dialog: search is something you do WHILE reading,
    so a modal that covers the document would hide the thing being
    searched.
  -->
  <div
    data-find-panel
    role="search"
    aria-label="Find in document"
    class="pointer-events-auto absolute right-4 top-3 z-40 flex items-center gap-1
           rounded-panel border border-border bg-surface-raised p-1.5 shadow-high"
  >
    <input
      ref="input"
      v-model="find.query"
      type="search"
      placeholder="Find"
      data-find-input
      aria-label="Find"
      class="min-h-8 w-48 rounded-control border border-border bg-surface-sunken px-2 text-[13px]"
      @keydown.enter.prevent="find.next()"
      @keydown.shift.enter.prevent="find.previous()"
      @keydown.esc.prevent="close()"
    >

    <!--
      The count is the answer to the question being asked, so it sits next
      to the box rather than somewhere the eye has to hunt for.
    -->
    <span data-find-count class="min-w-16 px-1 text-[12px] text-text-muted" role="status">
      <template v-if="find.searching">Searching…</template>
      <template v-else-if="find.query === ''" />
      <template v-else-if="find.count === 0">No matches</template>
      <template v-else>
        {{ find.current + 1 }} of {{ find.count }}<span v-if="find.capped">+</span>
      </template>
    </span>

    <IconButton size="sm" label="Previous match" data-find-prev
                :disabled="find.count === 0" @click="find.previous()">
      <ChevronUp :size="15" :stroke-width="1.5" />
    </IconButton>
    <IconButton size="sm" label="Next match" data-find-next
                :disabled="find.count === 0" @click="find.next()">
      <ChevronDown :size="15" :stroke-width="1.5" />
    </IconButton>

    <label class="flex items-center gap-1 px-1 text-[12px] text-text-muted">
      <input v-model="find.caseSensitive" type="checkbox" data-find-case class="accent-accent">
      Aa
    </label>
    <label class="flex items-center gap-1 px-1 text-[12px] text-text-muted">
      <input v-model="find.wholeWord" type="checkbox" data-find-whole class="accent-accent">
      Word
    </label>

    <IconButton
      size="sm"
      label="Replace"
      data-find-toggle-replace
      :active="showReplace"
      @click="showReplace = !showReplace"
    >
      <Replace :size="15" :stroke-width="1.5" />
    </IconButton>

    <IconButton size="sm" label="Close find" data-find-close @click="close()">
      <X :size="15" :stroke-width="1.5" />
    </IconButton>
  </div>

  <!--
    A second row rather than a wider one: replace is the less common half,
    and someone who only wants to find should not have to look past a
    control they are not using.
  -->
  <div
    v-if="showReplace"
    data-find-replace-row
    class="pointer-events-auto absolute right-4 top-16 z-40 flex items-center gap-1
           rounded-panel border border-border bg-surface-raised p-1.5 shadow-high"
  >
    <input
      v-model="replacement"
      type="text"
      placeholder="Replace with"
      data-find-replacement
      aria-label="Replace with"
      class="min-h-8 w-48 rounded-control border border-border bg-surface-sunken px-2 text-[13px]"
    >
    <button
      type="button"
      data-find-replace-one
      class="min-h-8 rounded-control border border-border px-2 text-[12px] disabled:opacity-40"
      :disabled="find.count === 0"
      @click="replaceOne()"
    >Replace</button>
    <button
      type="button"
      data-find-replace-all
      class="min-h-8 rounded-control border border-border px-2 text-[12px] disabled:opacity-40"
      :disabled="find.count === 0"
      @click="replaceAll()"
    >All</button>
    <span v-if="report" data-find-report class="px-1 text-[12px] text-text-muted" role="status">
      {{ report }}
    </span>
  </div>
</template>
