<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useFocusTrap } from '@/lib/useFocusTrap'
import { nanoid } from 'nanoid'
import type { SignatureObject, EditObject } from '@margin/pdf-core'
import Button from '@/ui/Button.vue'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { importImage } from '@/features/tools/importImage'
import { SIGNATURE_FACES, cssFamily, loadSignatureFaces } from '@/lib/fonts'
import { canvasToPng, cleanUpload, inkBounds, fillStroke } from './signatureImage'
import {
  listSignatures, saveSignature, deleteSignature, type SavedSignature,
} from './signatureStore'

const doc = useDocumentStore()
const edits = useEditsStore()
const tools = useToolsStore()

type Tab = 'draw' | 'type' | 'upload'
const tab = ref<Tab>('draw')

const PAD = { w: 600, h: 200 }
/** Widest a placed signature gets, in points. */
const PLACED_MAX_PT = 200

const surface = ref<HTMLElement | null>(null)
const pad = ref<HTMLCanvasElement | null>(null)
const typed = ref('')
const saved = ref<SavedSignature[]>([])

/**
 * Unchecked by default, and this is load-bearing rather than a styling
 * choice (spec 2.1): a signature is sensitive personal data, and someone
 * signing one document on a borrowed machine must not silently leave it in
 * that browser's storage.
 */
const remember = ref(false)

/** Preview of what removeBackground did, so Upload is not a black box. */
const uploadPreview = ref<string>('')
let previewUrl = ''

/**
 * Script faces, not body faces. A signature typed in Inter reads as typed
 * text rather than a signature, which is the same "feels broken" failure
 * spec 2.1 calls out for an un-background-removed photo. Loaded on demand
 * when this modal opens -- see loadSignatureFaces.
 */
const TYPE_FACES = SIGNATURE_FACES.map((f) => ({ label: f.family, css: cssFamily(f.family) }))
const face = ref(TYPE_FACES[0]!.css)

/** The in-flight pad stroke, deliberately outside reactivity (as InkCanvas). */
let strokes: number[][] = []
let stroke: number[] = []
let drawing = false

function padCtx(): CanvasRenderingContext2D | null {
  return pad.value?.getContext('2d') ?? null
}

/**
 * Repaint the pad from `strokes` plus the one in flight. Shares fillStroke
 * with the final rasterisation below, so what the user sees while drawing is
 * exactly the artwork that gets placed.
 */
function repaint(): void {
  const c = padCtx()
  if (!c) return
  c.clearRect(0, 0, PAD.w, PAD.h)
  c.fillStyle = '#111'
  for (const s of [...strokes, stroke]) fillStroke(c, s)
}

function padPoint(e: PointerEvent): [number, number] {
  const box = pad.value!.getBoundingClientRect()
  return [
    ((e.clientX - box.left) / box.width) * PAD.w,
    ((e.clientY - box.top) / box.height) * PAD.h,
  ]
}

function onDown(e: PointerEvent): void {
  if (!pad.value) return
  drawing = true
  stroke = padPoint(e)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}
function onMove(e: PointerEvent): void {
  if (!drawing) return
  stroke.push(...padPoint(e))
  repaint()
}
function onUp(): void {
  if (!drawing) return
  drawing = false
  if (stroke.length >= 4) strokes.push(stroke)
  stroke = []
  repaint()
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('pointercancel', onUp)
}

function clearPad(): void {
  strokes = []
  stroke = []
  repaint()
}

/** Render the active tab to a transparent PNG cropped to its ink. */
async function render(): Promise<{ data: Uint8Array; w: number; h: number } | undefined> {
  if (tab.value === 'upload') return pendingUpload.value

  const canvas = document.createElement('canvas')
  canvas.width = PAD.w
  canvas.height = PAD.h
  const c = canvas.getContext('2d')
  if (!c) return undefined

  if (tab.value === 'draw') {
    if (strokes.length === 0) return undefined
    c.fillStyle = '#111'
    for (const s of strokes) fillStroke(c, s)
  } else {
    if (!typed.value.trim()) return undefined
    c.fillStyle = '#111'
    c.font = `72px ${face.value}`
    c.textBaseline = 'middle'
    c.fillText(typed.value, 20, PAD.h / 2)
  }

  // Crop to the ink so the placed box hugs the marks rather than the pad.
  const box = inkBounds(c.getImageData(0, 0, PAD.w, PAD.h))
  if (!box) return undefined
  const out = document.createElement('canvas')
  out.width = box.w
  out.height = box.h
  out.getContext('2d')?.drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h)
  return { data: await canvasToPng(out), w: box.w, h: box.h }
}

const pendingUpload = ref<{ data: Uint8Array; w: number; h: number } | undefined>(undefined)

async function onUpload(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    // importImage caps the size and applies EXIF orientation; cleanUpload
    // then turns the paper transparent and crops to the ink.
    const normalised = await importImage(file)
    const bitmap = await createImageBitmap(new Blob([normalised.data.slice()], { type: normalised.mime }))
    try {
      const cleaned = await cleanUpload(bitmap)
      if (!cleaned) {
        doc.error = 'No signature was found in that image. Try a clearer photo.'
        return
      }
      pendingUpload.value = cleaned
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      previewUrl = URL.createObjectURL(new Blob([cleaned.data.slice()], { type: 'image/png' }))
      uploadPreview.value = previewUrl
    } finally {
      bitmap.close()
    }
  } catch (err) {
    doc.error = err instanceof Error ? err.message : 'Could not read that image.'
  }
}

function close(): void {
  tools.setTool('select')
}

// Keyboard users need focus to land in the dialog, stay in it, and go back
// where it came from. Escape cancels, which for this surface means closing.
useFocusTrap(surface, { onEscape: close })

async function place(sig: { data: Uint8Array; w: number; h: number }): Promise<void> {
  const pageId = doc.pageOrder[0]
  const page = pageId ? doc.pages[pageId] : undefined
  if (!page) return

  const [x0, y0, x1, y1] = page.geometry.cropBox
  const scale = Math.min(1, PLACED_MAX_PT / Math.max(sig.w, sig.h))
  const w = sig.w * scale
  const h = sig.h * scale
  const object: SignatureObject = {
    id: nanoid(10),
    pageId: page.id,
    kind: 'signature',
    data: sig.data,
    mime: 'image/png',
    rect: { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h },
    rotation: 0,
    z: edits.nextZ(),
    locked: false,
    opacity: 1,
  }
  edits.applyOp({ type: 'addObject', object: object as EditObject }, 'Add signature')

  // Reached only from the checked path: see signatureStore.ts.
  if (remember.value) {
    await saveSignature({ data: sig.data, width: sig.w, height: sig.h }, Date.now())
    saved.value = await listSignatures()
  }

  close()
  edits.select([object.id])
}

async function apply(): Promise<void> {
  const sig = await render()
  if (!sig) {
    doc.error = 'Draw, type, or upload a signature first.'
    return
  }
  await place(sig)
}

async function forget(id: number | undefined): Promise<void> {
  if (id === undefined) return
  await deleteSignature(id)
  saved.value = await listSignatures()
}

onMounted(async () => {
  repaint()
  // Without this the Type tab first renders in the fallback cursive and
  // snaps to the real face mid-typing -- and worse, a signature rendered
  // before the face loads is rasterised in the WRONG one.
  void loadSignatureFaces()
  saved.value = await listSignatures()
})

onBeforeUnmount(() => {
  onUp()
  if (previewUrl) URL.revokeObjectURL(previewUrl)
})
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Add a signature"
    data-signature-modal
    @click.self="close"
  >

    <div ref="surface" tabindex="-1" class="flex w-full max-w-2xl flex-col gap-3 rounded-panel bg-surface p-4 shadow-high">
      <div role="tablist" aria-label="Signature source" class="flex gap-1">
        <button
          v-for="t in (['draw', 'type', 'upload'] as const)"
          :key="t"
          type="button"
          role="tab"
          :aria-selected="tab === t"
          :data-tab="t"
          class="min-h-11 rounded-control px-3 text-[13px] capitalize"
          :class="tab === t ? 'bg-accent text-accent-fg' : 'text-text-muted hover:bg-surface-sunken'"
          @click="tab = t"
        >{{ t }}</button>
      </div>

      <div v-show="tab === 'draw'" class="flex flex-col gap-2">
        <canvas
          ref="pad"
          data-signature-pad
          :width="PAD.w"
          :height="PAD.h"
          class="w-full touch-none rounded-control border border-border bg-white"
          @pointerdown="onDown"
        />
        <button type="button" class="self-start text-[13px] text-accent" @click="clearPad">Clear</button>
      </div>

      <div v-show="tab === 'type'" class="flex flex-col gap-2">
        <input
          v-model="typed"
          data-signature-typed
          type="text"
          placeholder="Your name"
          aria-label="Signature text"
          class="min-h-11 rounded-control border border-border bg-surface-sunken px-3 text-[15px]"
        />
        <div class="flex gap-1">
          <button
            v-for="f in TYPE_FACES"
            :key="f.css"
            type="button"
            class="min-h-11 rounded-control px-3 text-[13px]"
            :class="face === f.css ? 'bg-accent text-accent-fg' : 'text-text-muted hover:bg-surface-sunken'"
            @click="face = f.css"
          >{{ f.label }}</button>
        </div>
        <p class="min-h-16 rounded-control border border-border bg-white px-3 py-2 text-[40px] leading-tight text-black"
           :style="{ fontFamily: face }">{{ typed }}</p>
      </div>

      <div v-show="tab === 'upload'" class="flex flex-col gap-2">
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          data-signature-upload
          aria-label="Signature photo"
          class="text-[13px]"
          @change="onUpload"
        />
        <!--
          A before/after preview, because background removal is destructive
          and silent: showing the result is how the user finds out it erased
          their signature BEFORE placing it on a contract.
        -->
        <div v-if="uploadPreview" class="rounded-control border border-border bg-[repeating-conic-gradient(#eee_0_25%,#fff_0_50%)] bg-[length:16px_16px] p-2">
          <img :src="uploadPreview" alt="Signature with the background removed" class="max-h-40" />
        </div>
      </div>

      <label class="flex items-center gap-2 text-[13px] text-text-muted">
        <input v-model="remember" type="checkbox" data-signature-remember />
        Save this signature on this device
      </label>

      <div v-if="saved.length" class="flex flex-col gap-1">
        <span class="text-[12px] text-text-subtle">Saved on this device</span>
        <div class="flex flex-wrap gap-2">
          <div v-for="s in saved" :key="s.id" class="flex items-center gap-1">
            <button
              type="button"
              class="rounded-control border border-border px-2 py-1 text-[12px]"
              @click="place({ data: s.data, w: s.width, h: s.height })"
            >Use ({{ s.width }}×{{ s.height }})</button>
            <button type="button" class="text-[12px] text-text-subtle" @click="forget(s.id)">Forget</button>
          </div>
        </div>
      </div>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" @click="close">Cancel</Button>
        <!--
          Never disabled: whether there is anything to place depends on
          canvas pixels, and a button that silently greys out gives no reason.
          apply() checks and says what is missing instead.
        -->
        <Button data-signature-apply @click="apply">Add signature</Button>
      </div>
    </div>
  </div>
</template>
