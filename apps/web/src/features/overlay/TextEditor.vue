<script setup lang="ts">
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue'
import { pdfRectToView } from '@margin/transform'
import type { TextObject } from '@margin/pdf-core'
import type { PageState } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { cssFamily, loadFont, LINE_HEIGHT } from '@/lib/fonts'
import { rgb } from './objects/svgPaint'

const props = defineProps<{ page: PageState; zoom: number }>()
const edits = useEditsStore()
const tools = useToolsStore()

/** Typing settles into one history entry after this long without a keystroke. */
const IDLE_COMMIT_MS = 400

const el = ref<HTMLElement | null>(null)

/**
 * The object being edited: the selection, when it is a text object on this
 * page and the editor has been opened on it. `editingId` lives in the tools
 * store so a re-render (or a zoom change) does not close the editor.
 */
const target = computed(() => {
  const id = tools.editingId
  if (!id) return undefined
  const o = edits.doc.objects[id]
  return o && o.kind === 'text' && o.pageId === props.page.id ? (o as TextObject) : undefined
})

const style = computed(() => {
  const o = target.value
  if (!o) return {}
  const b = pdfRectToView(o.rect, props.page.geometry, props.zoom)
  return {
    left: `${b.x}px`,
    top: `${b.y}px`,
    width: `${b.w}px`,
    minHeight: `${b.h}px`,
    // Point sizes scale with zoom exactly as the page does, so the caret
    // sits where the exported glyphs will.
    fontSize: `${o.fontSize * props.zoom}px`,
    lineHeight: String(LINE_HEIGHT),
    fontFamily: cssFamily(o.fontFamily),
    color: rgb(o.color),
    textAlign: o.align,
  }
})

/**
 * Typing must be ONE undo step, not one per keystroke. The transaction opens
 * on the first input and closes once typing has been idle for
 * IDLE_COMMIT_MS, or immediately on blur -- the same coalescing discipline
 * the inspector's sliders and the overlay's drags use.
 */
let open = false
let idle: ReturnType<typeof setTimeout> | undefined

function commitSoon(): void {
  if (idle) clearTimeout(idle)
  idle = setTimeout(finish, IDLE_COMMIT_MS)
}

function finish(): void {
  if (idle) { clearTimeout(idle); idle = undefined }
  if (!open) return
  open = false
  edits.endTransaction()
}

function onInput(e: Event): void {
  const o = target.value
  if (!o) return
  if (!open) {
    open = true
    edits.beginTransaction('Type')
  }
  // innerText, not textContent: it preserves the line breaks a
  // contenteditable expresses as <div>/<br>, which textContent flattens
  // into one run-together line.
  const text = (e.target as HTMLElement).innerText.replace(/\n$/, '')
  edits.applyOp({ type: 'updateObject', id: o.id, patch: { text } }, 'Type')
  commitSoon()
}

function stop(): void {
  finish()
  tools.stopEditing()
}

// Focus the editor as soon as it opens on a new object, and make sure the
// face is actually loaded so the caret is positioned against real metrics
// rather than the fallback's.
watch(target, async (o) => {
  if (!o) return
  await loadFont(o.fontFamily)
  await nextTick()
  const node = el.value
  if (!node) return
  node.innerText = o.text
  node.focus()
  const range = document.createRange()
  range.selectNodeContents(node)
  range.collapse(false)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}, { immediate: true })

// A pending transaction must not outlive the component -- unmounting
// mid-type (a zoom change unmounting the page, say) would otherwise leave
// the store's depth counter above zero and swallow the next gesture.
onBeforeUnmount(finish)
</script>

<template>
  <!--
    Layer 3: a real contenteditable in the DOM, NOT SVG text (spec 1.3).
    IME composition, mobile virtual keyboards, and the system caret all work
    here and none of them work inside <svg>.
  -->
  <div
    v-if="target"
    ref="el"
    data-text-editor
    contenteditable="plaintext-only"
    role="textbox"
    aria-multiline="true"
    aria-label="Edit text"
    class="pointer-events-auto absolute z-30 whitespace-pre-wrap break-words outline-none
           ring-2 ring-accent"
    :style="style"
    @input="onInput"
    @blur="stop"
    @keydown.esc.prevent="stop"
    @pointerdown.stop
  />
</template>
