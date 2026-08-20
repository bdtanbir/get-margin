<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useFocusTrap } from '@/lib/useFocusTrap'
import Button from '@/ui/Button.vue'
import { useDocumentStore } from '@/stores/document'
import { getPdfClient } from '@/workers/pdfClient'
import { parseRanges } from '@/lib/pageRanges'
import { zipFiles } from '@/lib/zip'
import { downloadBytes, imageFileName, MIME } from '@/lib/exportFile'
import { DPI_PRESETS, type RasterFormat } from '@margin/pdf-core'

const emit = defineEmits<{ close: [] }>()

const doc = useDocumentStore()
const surface = ref<HTMLElement | null>(null)
useFocusTrap(surface, { onEscape: () => emit('close') })

const format = ref<RasterFormat>('jpeg')
const dpi = ref<number>(150)
/** Empty means every page, which is what someone opening this dialog usually wants. */
const range = ref('')
const busy = ref(false)
const error = ref('')
const done = ref(0)
const dimensions = ref<{ width: number; height: number } | null>(null)

/** Zero-based page indices, flattened: unlike Split, every page here is its own file anyway. */
const pages = computed<number[]>(() => {
  if (!range.value.trim()) return doc.pageOrder.map((_, i) => i)
  try {
    return parseRanges(range.value, doc.pageCount).flat()
  } catch {
    return []
  }
})

const rangeError = computed(() => {
  if (!range.value.trim()) return ''
  try {
    parseRanges(range.value, doc.pageCount)
    return ''
  } catch (e) {
    return e instanceof Error ? e.message : 'That is not a page range.'
  }
})

/**
 * The pixel size, before committing.
 *
 * 300 DPI on A4 is 2550x3300, and a hundred of those is a download worth
 * warning about. Asking the worker is cheap -- it reads the page box and
 * multiplies, it does not render.
 */
watch(
  [dpi, pages],
  async () => {
    const first = pages.value[0]
    if (first === undefined) {
      dimensions.value = null
      return
    }
    try {
      dimensions.value = await getPdfClient().rasterSize(first, dpi.value)
    } catch {
      dimensions.value = null
    }
  },
  { immediate: true },
)

const summary = computed(() => {
  const count = pages.value.length
  if (count === 0) return ''
  const size = dimensions.value ? `${dimensions.value.width} × ${dimensions.value.height} px` : ''
  const files = count === 1 ? '1 image' : `${count} images, as a zip`
  return size ? `${files} · ${size}` : files
})

async function run(): Promise<void> {
  if (busy.value) return
  const list = pages.value
  if (list.length === 0) {
    error.value = rangeError.value || 'There are no pages to export.'
    return
  }

  busy.value = true
  error.value = ''
  done.value = 0
  try {
    const client = getPdfClient()
    const highest = Math.max(...list) + 1
    const entries: Array<{ name: string; data: Uint8Array }> = []

    // Sequential, not Promise.all. Each page is a full-resolution bitmap
    // and there is one worker: firing all of them at once would queue the
    // same work while holding every result in memory at the same time.
    for (const index of list) {
      const page = await client.rasterise(index, dpi.value, format.value)
      entries.push({
        name: imageFileName(doc.fileName, index + 1, format.value, highest),
        data: page.bytes,
      })
      done.value += 1
    }

    if (entries.length === 1) {
      const only = entries[0]!
      downloadBytes(only.data, only.name, format.value === 'png' ? MIME.png : MIME.jpeg)
    } else {
      // One download, not N. Browsers throttle successive programmatic
      // downloads, so a twelve-page export would silently deliver two.
      const base = doc.fileName.replace(/\.pdf$/i, '') || 'document'
      downloadBytes(await zipFiles(entries), `${base}-images.zip`, MIME.zip)
    }
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'These pages could not be exported as images.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Export as images"
    data-image-export
    @click.self="emit('close')"
  >
    <div
      ref="surface"
      tabindex="-1"
      class="my-8 flex w-full max-w-md flex-col gap-4 rounded-panel bg-surface p-5 shadow-high"
    >
      <h2 class="text-[17px] font-medium">Export as images</h2>

      <div class="flex flex-col gap-1" role="group" aria-label="Image format">
        <label
          v-for="f in [
            { id: 'jpeg' as const, label: 'JPEG', note: 'Smaller files, best for photos' },
            { id: 'png' as const, label: 'PNG', note: 'Larger files, sharper text' },
          ]"
          :key="f.id"
          class="flex items-center gap-2 rounded-control border p-2 text-[13px]"
          :class="format === f.id ? 'border-accent bg-accent/5' : 'border-border'"
        >
          <input
            type="radio"
            name="image-format"
            class="accent-accent"
            :data-image-format="f.id"
            :checked="format === f.id"
            @change="format = f.id"
          >
          <span class="font-medium">{{ f.label }}</span>
          <span class="text-text-subtle">{{ f.note }}</span>
        </label>
      </div>

      <!--
        Named for what the choice is for, not for the number. "300 DPI"
        means something to a printer and nothing to everyone else.
      -->
      <div class="flex flex-col gap-1" role="group" aria-label="Image quality">
        <label
          v-for="p in DPI_PRESETS"
          :key="p.dpi"
          class="flex items-center gap-2 rounded-control border p-2 text-[13px]"
          :class="dpi === p.dpi ? 'border-accent bg-accent/5' : 'border-border'"
        >
          <input
            type="radio"
            name="image-dpi"
            class="accent-accent"
            :data-image-dpi="p.dpi"
            :checked="dpi === p.dpi"
            @change="dpi = p.dpi"
          >
          <span class="font-medium">{{ p.label }}</span>
          <span class="text-text-subtle">{{ p.note }}</span>
        </label>
      </div>

      <label class="flex flex-col gap-1 text-[13px]">
        <span class="font-medium">Pages</span>
        <input
          v-model="range"
          type="text"
          data-image-range
          placeholder="All pages — or 1-3, 5"
          class="rounded-control border border-border bg-surface px-2 py-1.5"
        >
      </label>

      <p v-if="rangeError" data-image-range-error class="text-[12px] text-danger">
        {{ rangeError }}
      </p>
      <p v-else-if="summary" data-image-summary class="text-[12px] text-text-subtle">
        {{ summary }}
      </p>

      <!--
        The load-bearing sentence. Every OTHER conversion in this product
        sends a file to a server and asks first; this one does not, and a
        user who has seen that consent dialog once will reasonably assume
        this is the same thing unless it says otherwise.
      -->
      <p data-image-privacy class="text-[12px] text-text-muted">
        This happens on your device. Nothing is uploaded, and no consent step is
        needed because no file leaves your computer.
      </p>

      <p v-if="busy && pages.length > 1" data-image-progress class="text-[12px] text-text-subtle">
        Page {{ Math.min(done + 1, pages.length) }} of {{ pages.length }}…
      </p>
      <p v-if="error" data-image-error class="text-[13px] text-danger">{{ error }}</p>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" data-image-cancel @click="emit('close')">Cancel</Button>
        <Button
          variant="primary"
          data-image-run
          :loading="busy"
          :disabled="pages.length === 0"
          @click="run"
        >Export</Button>
      </div>
    </div>
  </div>
</template>
