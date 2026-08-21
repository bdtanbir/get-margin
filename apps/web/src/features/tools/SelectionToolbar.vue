<script setup lang="ts">
import { computed } from 'vue'
import { nanoid } from 'nanoid'
import {
  Copy, Trash2, BringToFront, SendToBack, Lock, LockOpen,
  Highlighter, Underline, Strikethrough, SquareSlash,
} from 'lucide-vue-next'
import { objectViewRect } from '@/features/overlay/objectViewRect'
import IconButton from '@/ui/IconButton.vue'
import type { PageState } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useSelectionStore } from '@/stores/selection'
import type { MarkupObject, RedactionObject, EditObject } from '@margin/pdf-core'

const props = defineProps<{ page: PageState; zoom: number }>()
const edits = useEditsStore()
const selection = useSelectionStore()

/** How far above the selection box the toolbar floats, in CSS pixels. */
const GAP_PX = 44

/** Offset applied to a duplicate so it does not hide under the original. */
const DUPLICATE_OFFSET_PT = 12

const selected = computed(() => {
  const id = edits.selection[0]
  const o = id ? edits.doc.objects[id] : undefined
  return o && o.pageId === props.page.id ? o : undefined
})

const style = computed(() => {
  const o = selected.value
  if (!o) return {}
  const b = objectViewRect(o, props.page.geometry, props.zoom)
  return { left: `${b.x}px`, top: `${b.y - GAP_PX}px` }
})

/** Objects sharing this page, which is what front/back are relative to. */
const siblings = computed(() =>
  Object.values(edits.doc.objects).filter((o) => o.pageId === props.page.id),
)

function duplicate(): void {
  const o = selected.value
  if (!o) return
  const copy = {
    ...o,
    id: nanoid(10),
    rect: { ...o.rect, x: o.rect.x + DUPLICATE_OFFSET_PT, y: o.rect.y - DUPLICATE_OFFSET_PT },
    z: edits.nextZ(),
  }
  edits.applyOp({ type: 'addObject', object: copy }, 'Duplicate')
  edits.select([copy.id])
}

function remove(): void {
  const o = selected.value
  if (!o) return
  edits.applyOp({ type: 'deleteObject', id: o.id }, 'Delete')
  edits.clearSelection()
}

function bringToFront(): void {
  const o = selected.value
  if (!o) return
  const top = Math.max(...siblings.value.map((s) => s.z))
  edits.applyOp({ type: 'reorder', id: o.id, z: top + 1 }, 'Bring to front')
}

function sendToBack(): void {
  const o = selected.value
  if (!o) return
  const bottom = Math.min(...siblings.value.map((s) => s.z))
  // reorder() also advances nextZ when z is high, which a negative z never
  // triggers -- back is genuinely below everything, not a wrapped-around top.
  edits.applyOp({ type: 'reorder', id: o.id, z: bottom - 1 }, 'Send to back')
}

/**
 * Markup actions appear when TEXT is selected rather than an object, which
 * is a different toolbar with a different anchor: it follows the selected
 * text, not an object's box.
 */
const textSelected = computed(
  () => selection.pageId === props.page.id && selection.hasSelection,
)

const MARKUP_COLOURS = {
  highlight: [1, 0.9, 0.2] as [number, number, number],
  underline: [0, 0.35, 0.9] as [number, number, number],
  strikeout: [0.85, 0.1, 0.1] as [number, number, number],
}

/** Where the text-markup toolbar floats: just above the first selected quad. */
const textStyle = computed(() => {
  const q = selection.selectedQuads[0]
  if (!q) return {}
  // Quads are in page space (points, top-down), and the overlay's box is the
  // page at `zoom` scale, so view pixels are points * zoom directly.
  const left = Math.min(q[0], q[4]) * props.zoom
  const top = Math.min(q[1], q[3]) * props.zoom
  return { left: `${left}px`, top: `${top - GAP_PX}px` }
})

function markup(kind: 'highlight' | 'underline' | 'strikeout'): void {
  const quads = selection.selectedQuads
  if (quads.length === 0) return

  // The object's `rect` is raw bottom-up PDF space like every other object,
  // while its `quads` stay in MuPDF page space -- see the MarkupObject type
  // and write/objects/markup.ts. The rect is selection geometry only; the
  // exported annotation derives its own box from the quads.
  const [, y0, , y1] = props.page.geometry.cropBox
  const pageH = y1 - y0
  let minX = Infinity, minTop = Infinity, maxX = -Infinity, maxBottom = -Infinity
  for (const q of quads) {
    for (let i = 0; i < 8; i += 2) {
      minX = Math.min(minX, q[i]!); maxX = Math.max(maxX, q[i]!)
      minTop = Math.min(minTop, q[i + 1]!); maxBottom = Math.max(maxBottom, q[i + 1]!)
    }
  }

  const object: MarkupObject = {
    id: nanoid(10),
    pageId: props.page.id,
    kind,
    quads: quads.map((q) => [...q]),
    color: MARKUP_COLOURS[kind],
    rect: { x: minX, y: pageH - maxBottom, w: maxX - minX, h: maxBottom - minTop },
    rotation: 0,
    z: edits.nextZ(),
    locked: false,
    opacity: 1,
  }
  edits.applyOp({ type: 'addObject', object: object as EditObject }, `Add ${kind}`)
  selection.clear()
  edits.select([object.id])
}

/**
 * Remove the selected text from the document.
 *
 * Shares the markup path's geometry exactly -- same quads, same rect
 * derivation -- because it is the same gesture over the same selection. What
 * differs is everything after export: markup annotates, this destroys.
 *
 * No confirmation dialog. The action is undoable in the editor like any
 * other op, and the destruction happens at export; a modal here would train
 * people to dismiss modals rather than tell them anything true. What DOES
 * belong in front of them is the distinction from whiteout, which the tool
 * label and the whiteout notice both carry.
 */
function redact(): void {
  const quads = selection.selectedQuads
  if (quads.length === 0) return

  const [, y0, , y1] = props.page.geometry.cropBox
  const pageH = y1 - y0
  let minX = Infinity, minTop = Infinity, maxX = -Infinity, maxBottom = -Infinity
  for (const q of quads) {
    for (let i = 0; i < 8; i += 2) {
      minX = Math.min(minX, q[i]!); maxX = Math.max(maxX, q[i]!)
      minTop = Math.min(minTop, q[i + 1]!); maxBottom = Math.max(maxBottom, q[i + 1]!)
    }
  }

  const object: RedactionObject = {
    id: nanoid(10),
    pageId: props.page.id,
    kind: 'redaction',
    quads: quads.map((q) => [...q]),
    // A mark by default: a redaction nobody can see is one nobody can
    // check, including the person who made it.
    blackBox: true,
    rect: { x: minX, y: pageH - maxBottom, w: maxX - minX, h: maxBottom - minTop },
    rotation: 0,
    z: edits.nextZ(),
    locked: false,
    opacity: 1,
  }
  edits.applyOp({ type: 'addObject', object: object as EditObject }, 'Redact')
  selection.clear()
  edits.select([object.id])
}

function toggleLock(): void {
  const o = selected.value
  if (!o) return
  edits.applyOp(
    { type: 'updateObject', id: o.id, patch: { locked: !o.locked } },
    o.locked ? 'Unlock' : 'Lock',
  )
}
</script>

<template>
  <!--
    Deliberately NOT disabled on a locked object: lock guards dragging and
    resizing, not the controls that unlock, delete, or reorder it. A toolbar
    that locks itself out is a trap with no exit.
  -->
  <!--
    The text-markup toolbar, shown while TEXT is selected. Separate from the
    object toolbar below because it anchors to the selected text rather than
    to an object's box, and the two selections are mutually exclusive.
  -->
  <div
    v-if="textSelected"
    data-markup-toolbar
    class="pointer-events-auto absolute z-30 flex items-center gap-0.5 rounded-control
           border border-border bg-surface-raised px-1 py-0.5 shadow-high"
    :style="textStyle"
    @pointerdown.stop
  >
    <IconButton size="sm" label="Highlight" @click="markup('highlight')">
      <Highlighter :size="16" :stroke-width="1.5" />
    </IconButton>
    <IconButton size="sm" label="Underline" @click="markup('underline')">
      <Underline :size="16" :stroke-width="1.5" />
    </IconButton>
    <IconButton size="sm" label="Strikeout" @click="markup('strikeout')">
      <Strikethrough :size="16" :stroke-width="1.5" />
    </IconButton>
    <!--
      Separated and coloured, because it is the one control here that
      destroys rather than annotates. Sitting flush with the markup buttons
      would make it look like a fourth way of colouring text.
    -->
    <span class="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
    <IconButton size="sm" label="Redact" data-redact class="text-danger" @click="redact()">
      <SquareSlash :size="16" :stroke-width="1.5" />
    </IconButton>
  </div>

  <div
    v-if="selected"
    data-selection-toolbar
    class="pointer-events-auto absolute z-30 flex items-center gap-0.5 rounded-control
           border border-border bg-surface-raised px-1 py-0.5 shadow-high"
    :style="style"
    @pointerdown.stop
  >
    <IconButton size="sm" label="Duplicate" @click="duplicate">
      <Copy :size="16" :stroke-width="1.5" />
    </IconButton>
    <IconButton size="sm" label="Bring to front" @click="bringToFront">
      <BringToFront :size="16" :stroke-width="1.5" />
    </IconButton>
    <IconButton size="sm" label="Send to back" @click="sendToBack">
      <SendToBack :size="16" :stroke-width="1.5" />
    </IconButton>
    <IconButton
      size="sm"
      :label="selected.locked ? 'Unlock' : 'Lock'"
      :active="selected.locked"
      @click="toggleLock"
    >
      <LockOpen v-if="selected.locked" :size="16" :stroke-width="1.5" />
      <Lock v-else :size="16" :stroke-width="1.5" />
    </IconButton>
    <IconButton size="sm" label="Delete" @click="remove">
      <Trash2 :size="16" :stroke-width="1.5" />
    </IconButton>
  </div>
</template>
