<script setup lang="ts">
import { ref, computed } from 'vue'
import { viewRectToPdf, pdfRectToView, type ViewRect } from '@margin/transform'
import Button from '@/ui/Button.vue'
import type { PageState } from '@/stores/document'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { useViewportStore } from '@/stores/viewport'
import { useDragGesture } from '@/features/overlay/useDragGesture'
import { useFocusTrap } from '@/lib/useFocusTrap'

const props = defineProps<{ page: PageState; zoom: number }>()

const doc = useDocumentStore()
const edits = useEditsStore()
const tools = useToolsStore()
const vp = useViewportStore()

/** Below this the drag is a stray click, not a crop. */
const MIN_DRAG_PX = 6

const controls = ref<HTMLElement | null>(null)
const box = ref<ViewRect | undefined>(undefined)
const applyToAll = ref(false)

/** The page's current crop, so opening the tool shows what is already set. */
const current = computed(() => pdfRectToView(
  {
    x: props.page.geometry.cropBox[0],
    y: props.page.geometry.cropBox[1],
    w: props.page.geometry.cropBox[2] - props.page.geometry.cropBox[0],
    h: props.page.geometry.cropBox[3] - props.page.geometry.cropBox[1],
  },
  props.page.geometry,
  props.zoom,
))

const style = computed(() => {
  const b = box.value
  if (!b) return {}
  return { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` }
})

function onPointerDown(e: PointerEvent): void {
  const surface = e.currentTarget as HTMLElement | null
  if (!surface) return
  const rect = surface.getBoundingClientRect()
  const originX = e.clientX - rect.left
  const originY = e.clientY - rect.top
  box.value = undefined

  const { onPointerDown: begin } = useDragGesture({
    onMove: ({ dx, dy }) => {
      box.value = {
        x: Math.min(originX, originX + dx),
        y: Math.min(originY, originY + dy),
        w: Math.abs(dx),
        h: Math.abs(dy),
      }
    },
    onEnd: () => {
      const b = box.value
      if (b && (b.w < MIN_DRAG_PX || b.h < MIN_DRAG_PX)) box.value = undefined
    },
  })
  begin(e)
}

function cancel(): void {
  box.value = undefined
  tools.setTool('select')
}

// Escape cancels the crop rather than closing a dialog -- which is why the
// trap routes Escape out rather than deciding for itself.
useFocusTrap(controls, { onEscape: cancel })

function apply(): void {
  const b = box.value
  if (!b) return
  // Converted ONCE, here, through @margin/transform. No component does its
  // own coordinate arithmetic (spec 1.4).
  const rect = viewRectToPdf(b, props.page.geometry, props.zoom)
  const targets = applyToAll.value ? doc.pageOrder : [props.page.id]

  edits.withTransaction(targets.length === 1 ? 'Crop page' : 'Crop pages', () => {
    for (const id of targets) edits.applyOp({ type: 'cropPage', pageId: id, cropBox: rect }, 'Crop')
  })
  // Crop changes what MuPDF renders, unlike every Phase 2 edit.
  for (const id of targets) vp.invalidate(id)

  box.value = undefined
  tools.setTool('select')
}

function clearCrop(): void {
  edits.applyOp({ type: 'cropPage', pageId: props.page.id, cropBox: null }, 'Remove crop')
  vp.invalidate(props.page.id)
  box.value = undefined
  tools.setTool('select')
}
</script>

<template>
  <div class="absolute inset-0 z-40" data-crop-overlay>
    <!-- Drag surface. Above the objects, because cropping is a page action. -->
    <div
      class="pointer-events-auto absolute inset-0 cursor-crosshair bg-black/20"
      data-crop-surface
      @pointerdown="onPointerDown"
    />

    <div
      v-if="box"
      class="pointer-events-none absolute border-2 border-accent bg-transparent shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
      data-crop-box
      :style="style"
    />

    <div
      ref="controls"
      tabindex="-1"
      role="dialog"
      aria-label="Crop this page"
      class="pointer-events-auto absolute inset-x-2 bottom-2 flex flex-col gap-2 rounded-panel
             border border-border bg-surface p-3 shadow-high"
    >
      <!--
        Load-bearing copy, not decoration. Cropping HIDES: the content
        outside the box stays in the file and any PDF tool can bring it
        back. Same honesty rule as whiteout (spec 2.1) -- and the same
        reason: someone cropping a bank statement to hide an account number
        must not believe it is gone.
      -->
      <p class="text-[12px] text-text-muted" data-crop-notice>
        Cropping hides the area outside the box. The hidden content is still in the
        file and any PDF tool can bring it back.
      </p>

      <label class="flex items-center gap-2 text-[13px] text-text-muted">
        <input v-model="applyToAll" type="checkbox" data-crop-all />
        Apply to all {{ doc.pageCount }} pages
      </label>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" data-crop-clear @click="clearCrop">Remove crop</Button>
        <Button variant="ghost" data-crop-cancel @click="cancel">Cancel</Button>
        <Button data-crop-apply :disabled="!box" @click="apply">Crop</Button>
      </div>
    </div>
  </div>
</template>
