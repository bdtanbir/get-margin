<script setup lang="ts">
import { computed } from 'vue'
import { nanoid } from 'nanoid'
import {
  Copy, Trash2, BringToFront, SendToBack, Lock, LockOpen,
  Highlighter, Underline, Strikethrough, SquareSlash, Bold, Italic, Link2, Move,
} from 'lucide-vue-next'
import { objectViewRect } from '@/features/overlay/objectViewRect'
import IconButton from '@/ui/IconButton.vue'
import type { PageState } from '@/stores/document'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useSelectionStore } from '@/stores/selection'
import { useViewportStore } from '@/stores/viewport'
import { DEFAULT_FAMILY } from '@/lib/fonts'
import { askForUri, normalizeUri } from '@/lib/linkUrl'
import { sampleBackground } from '@/features/patch/sampleBackground'
import {
  buildLinePatch, documentStyle, isPristine, lineBox, patchOnLine, styleOf,
} from '@/features/patch/linePatch'
import { deleteOpFor } from '@/features/patch/patchDelete'
import type {
  LineRun, LinkObject, MarkupObject, RedactionObject, EditObject,
} from '@margin/pdf-core'

const props = defineProps<{ page: PageState; zoom: number }>()
const doc = useDocumentStore()
const edits = useEditsStore()
const selection = useSelectionStore()
const vp = useViewportStore()

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

/**
 * The kinds whose `rect` is the thing they COVER rather than where their
 * own content is drawn. A copy of one is displaced by its offset, never by
 * its rect -- moving the rect would move the cover off the thing it is
 * there to hide.
 */
const COVERING_KINDS = ['imagePatch', 'regionPatch']

function duplicate(): void {
  const o = selected.value
  if (!o) return
  let nudge: Record<string, unknown>
  if (COVERING_KINDS.includes(o.kind)) {
    const from = (o as { offset?: { dx: number; dy: number } }).offset ?? { dx: 0, dy: 0 }
    // Page space is top-down, so BOTH are positive to land down and to the
    // right -- unlike the rect below, which is bottom-up PDF space and
    // subtracts to go down.
    nudge = {
      offset: { dx: from.dx + DUPLICATE_OFFSET_PT, dy: from.dy + DUPLICATE_OFFSET_PT },
    }
  } else {
    nudge = {
      rect: { ...o.rect, x: o.rect.x + DUPLICATE_OFFSET_PT, y: o.rect.y - DUPLICATE_OFFSET_PT },
    }
  }
  const copy = { ...o, id: nanoid(10), ...nudge, z: edits.nextZ() } as typeof o
  edits.applyOp({ type: 'addObject', object: copy }, 'Duplicate')
  edits.select([copy.id])
}

function remove(): void {
  const o = selected.value
  if (!o) return
  // Not always `deleteObject`: a patch carrying a copy loses the copy and
  // keeps the cover, or the logo the user just asked to delete comes
  // straight back. See `deleteOpFor`.
  const op = deleteOpFor(o)
  edits.applyOp(op, 'Delete')
  // The object survives a peeled copy, so it stays selected -- pressing
  // Delete again removes the edit itself.
  if (op.type === 'deleteObject') edits.clearSelection()
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

/**
 * The box a run of quads covers, in raw bottom-up PDF space.
 *
 * The quads arrive in MuPDF page space (top-down) and every object's `rect`
 * is bottom-up, so this flip is the one conversion the three selection
 * actions all need -- see MarkupObject for why the two spaces coexist.
 */
function boxOf(quads: number[][]): { x: number; y: number; w: number; h: number } {
  const [, y0, , y1] = props.page.geometry.cropBox
  const pageH = y1 - y0
  let minX = Infinity, minTop = Infinity, maxX = -Infinity, maxBottom = -Infinity
  for (const q of quads) {
    for (let i = 0; i < 8; i += 2) {
      minX = Math.min(minX, q[i]!); maxX = Math.max(maxX, q[i]!)
      minTop = Math.min(minTop, q[i + 1]!); maxBottom = Math.max(maxBottom, q[i + 1]!)
    }
  }
  return { x: minX, y: pageH - maxBottom, w: maxX - minX, h: maxBottom - minTop }
}

function markup(kind: 'highlight' | 'underline' | 'strikeout'): void {
  const quads = selection.selectedQuads
  if (quads.length === 0) return

  // The object's `rect` is raw bottom-up PDF space like every other object,
  // while its `quads` stay in MuPDF page space -- see the MarkupObject type
  // and write/objects/markup.ts. The rect is selection geometry only; the
  // exported annotation derives its own box from the quads.
  const object: MarkupObject = {
    id: nanoid(10),
    pageId: props.page.id,
    kind,
    quads: quads.map((q) => [...q]),
    color: MARKUP_COLOURS[kind],
    rect: boxOf(quads),
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

  const object: RedactionObject = {
    id: nanoid(10),
    pageId: props.page.id,
    kind: 'redaction',
    quads: quads.map((q) => [...q]),
    // A mark by default: a redaction nobody can see is one nobody can
    // check, including the person who made it.
    blackBox: true,
    rect: boxOf(quads),
    rotation: 0,
    z: edits.nextZ(),
    locked: false,
    opacity: 1,
  }
  edits.applyOp({ type: 'addObject', object: object as EditObject }, 'Redact')
  selection.clear()
  edits.select([object.id])
}

/**
 * Turn the selected text into a link hotspot.
 *
 * ONE OBJECT PER LINE, unlike the markup actions above. A markup annotation
 * carries /QuadPoints and can describe a ragged multi-line run exactly; a
 * link cannot -- fz_link is a single rect (see write/objects/link.ts). A
 * selection ending mid-line would therefore become a box covering the rest
 * of that line too, making text nobody selected clickable. Per line, the
 * hotspot hugs what was selected.
 *
 * The URL is TYPED, never derived from the page, and it is asked for and
 * validated BEFORE any object exists -- so a rejected or cancelled link
 * leaves nothing behind to clean up. Same order the draw tool uses, and
 * what keeps a `javascript:` URL unrepresentable rather than merely refused
 * at export.
 */
function addLink(): void {
  const quads = selection.selectedQuads
  if (quads.length === 0) return

  // ALWAYS an empty box. Offering the selected text as the URL reads like a
  // kindness -- most documents that print an address mean it -- but a guess
  // that is usually right is the wrong trade here: a wrong one is a working
  // link to somewhere nobody chose, and it looks exactly like a right one
  // until someone clicks it. The URL is the user's to state.
  const answer = askForUri('')
  if (answer === null) return

  let uri: string
  try {
    uri = normalizeUri(answer)
  } catch (e) {
    doc.error = e instanceof Error ? e.message : 'That link is not valid.'
    return
  }

  const ids: string[] = []
  edits.withTransaction('Add link', () => {
    for (const quad of quads) {
      const object: LinkObject = {
        id: nanoid(10),
        pageId: props.page.id,
        kind: 'link',
        uri,
        rect: boxOf([quad]),
        rotation: 0,
        z: edits.nextZ(),
        locked: false,
        opacity: 1,
      }
      ids.push(object.id)
      edits.applyOp({ type: 'addObject', object: object as EditObject }, 'Add link')
    }
  })
  selection.clear()
  // Straight to the object selection, which puts the Inspector's URL field
  // in front of the user -- where a mistyped URL gets fixed.
  edits.select(ids)
}

/**
 * The lines the selection touches, with their indices.
 *
 * WHOLE LINES, and that is the honest limit of this control rather than a
 * shortcut. A patch covers and redraws an entire line -- it is addressed by
 * line index and guarded by a hash of the line's text -- so there is no way
 * to set three words of a line in bold without rebuilding the patch format
 * around character ranges. Selecting part of a line and pressing Bold
 * therefore bolds the line, which is why the buttons say so.
 */
const touchedLines = computed<Array<{ index: number; line: LineRun }>>(() => {
  const r = selection.range
  const idx = selection.index
  if (!r || !idx || !textSelected.value) return []
  const out: Array<{ index: number; line: LineRun }> = []
  for (let i = r.from.line; i <= r.to.line; i++) {
    const line = idx.lines[i]
    if (line && line.chars.length > 0) out.push({ index: i, line })
  }
  return out
})

/** What a line is set in NOW: its patch's style if it has one, else the document's. */
function currentStyle(index: number, line: LineRun) {
  const patch = patchOnLine(Object.values(edits.doc.objects), props.page.id, index)
  return patch ? styleOf(patch) : documentStyle(line)
}

/**
 * Whether every touched line already carries the style, which is both the
 * button's pressed state and what decides the direction of the toggle.
 *
 * EVERY, not some: selecting a bold heading together with the regular
 * paragraph under it and pressing Bold should make the whole selection
 * bold, not un-bold the half that already was.
 */
function allHave(axis: 'bold' | 'italic'): boolean {
  const lines = touchedLines.value
  return lines.length > 0 && lines.every(({ index, line }) => currentStyle(index, line)[axis])
}

const allBold = computed(() => allHave('bold'))
const allItalic = computed(() => allHave('italic'))

/**
 * Set or clear one style axis across every line the selection touches.
 *
 * ONE undo step for the whole gesture: pressing Bold over a paragraph is
 * one thing the user did, and making it eight is making Ctrl+Z lie.
 *
 * A patch that ends up drawing exactly what the document already draws is
 * DELETED rather than kept. Toggling Bold on and off again would otherwise
 * leave a cover painted over the line and redrawn identically -- invisible
 * on white, a visible scar anywhere the background is not flat, and a row
 * in the layers list for an edit that is not one.
 */
function toggleStyle(axis: 'bold' | 'italic'): void {
  const lines = touchedLines.value
  if (lines.length === 0) return
  const next = !allHave(axis)
  const label = `${next ? '' : 'Remove '}${axis === 'bold' ? 'Bold' : 'Italic'}`

  edits.withTransaction(label, () => {
    for (const { index, line } of lines) {
      const existing = patchOnLine(Object.values(edits.doc.objects), props.page.id, index)

      if (existing) {
        const updated = { ...existing, [axis]: next }
        if (isPristine(updated, line)) {
          edits.applyOp({ type: 'deleteObject', id: existing.id }, label)
        } else {
          edits.applyOp({ type: 'updateObject', id: existing.id, patch: { [axis]: next } }, label)
        }
        continue
      }

      const bitmap = vp.bitmapFor(props.page.id)
      const object = buildLinePatch({
        pageId: props.page.id,
        lineIndex: index,
        line,
        fontFamily: DEFAULT_FAMILY,
        style: { ...documentStyle(line), [axis]: next },
        background: sampleBackground(bitmap, lineBox(line), bitmap ? bitmap.scale : 1),
        z: edits.nextZ(),
      })
      // A line already set the way the button asks for needs no patch at
      // all -- the document is drawing it correctly.
      if (isPristine(object, line)) continue
      edits.applyOp({ type: 'addObject', object: object as EditObject }, label)
    }
  })
}

/**
 * Arm a move on a line the document itself drew.
 *
 * The drag lives in `SelectionChrome` and needs an OBJECT. An unedited line
 * is not one -- it is glyphs in the page bitmap, addressable but not
 * draggable -- so this makes the line into a patch and hands it over. The
 * patch it creates is a pure carrier: same words, same style, no offset
 * yet. Only the drag that follows changes anything visible.
 *
 * ONE LINE ONLY, which is why the button hides over a multi-line selection:
 * a patch covers exactly one line and the chrome drags exactly one object,
 * so a group move is something neither the format nor the gesture can
 * express, and offering it would be a promise this cannot keep.
 *
 * Reuses the line's existing patch when it has one. Two patches on a line
 * each cover the other and the second silently discards the first -- see
 * `patchOnLine`.
 */
const movableLine = computed(() => (touchedLines.value.length === 1 ? touchedLines.value[0] : undefined))

function moveLine(): void {
  const target = movableLine.value
  if (!target) return
  const { index, line } = target

  edits.withTransaction('Move line', () => {
    const existing = patchOnLine(Object.values(edits.doc.objects), props.page.id, index)
    if (existing) {
      edits.select([existing.id])
    } else {
      const bitmap = vp.bitmapFor(props.page.id)
      const object = buildLinePatch({
        pageId: props.page.id,
        lineIndex: index,
        line,
        fontFamily: DEFAULT_FAMILY,
        style: documentStyle(line),
        background: sampleBackground(bitmap, lineBox(line), bitmap ? bitmap.scale : 1),
        z: edits.nextZ(),
        // A moved patch is drawn outside the box it was fitted to, so
        // fitting to that box would cut text to a constraint that has
        // stopped applying. The writer enforces this too; matching here
        // keeps the stored object honest about what it will do.
        fit: 'overflow',
      })
      edits.applyOp({ type: 'addObject', object: object as EditObject }, 'Move line')
      edits.select([object.id])
    }
    // The two selections are mutually exclusive: the markup toolbar anchors
    // to selected text and the chrome to a selected object. Leaving the
    // text selected would show both toolbars and drag neither.
    selection.clear()
  })
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
    <!--
      Bold and Italic act on WHOLE LINES, and the labels say so because the
      alternative is a control that quietly does more than it was asked. A
      patch is addressed by line index and guarded by a hash of the line's
      text, so styling three words of a line is not something the format can
      express -- see touchedLines.
    -->
    <IconButton
      size="sm"
      label="Bold line"
      data-style-bold
      :active="allBold"
      @click="toggleStyle('bold')"
    >
      <Bold :size="16" :stroke-width="1.5" />
    </IconButton>
    <IconButton
      size="sm"
      label="Italic line"
      data-style-italic
      :active="allItalic"
      @click="toggleStyle('italic')"
    >
      <Italic :size="16" :stroke-width="1.5" />
    </IconButton>
    <span class="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
    <IconButton size="sm" label="Highlight" @click="markup('highlight')">
      <Highlighter :size="16" :stroke-width="1.5" />
    </IconButton>
    <IconButton size="sm" label="Underline" @click="markup('underline')">
      <Underline :size="16" :stroke-width="1.5" />
    </IconButton>
    <IconButton size="sm" label="Strikeout" @click="markup('strikeout')">
      <Strikethrough :size="16" :stroke-width="1.5" />
    </IconButton>
    <IconButton size="sm" label="Link" data-link @click="addLink()">
      <Link2 :size="16" :stroke-width="1.5" />
    </IconButton>
    <!--
      Hidden rather than disabled over a multi-line selection. A disabled
      control says "not now"; this one is never available for a paragraph,
      because a patch is one line and the chrome drags one object.
    -->
    <IconButton
      v-if="movableLine"
      size="sm"
      label="Move line"
      data-move-line
      @click="moveLine()"
    >
      <Move :size="16" :stroke-width="1.5" />
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
