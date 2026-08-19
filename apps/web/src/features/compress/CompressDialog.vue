<script setup lang="ts">
import { ref, computed } from 'vue'
import { useFocusTrap } from '@/lib/useFocusTrap'
import Button from '@/ui/Button.vue'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { getPdfClient } from '@/workers/pdfClient'
import { downloadBytes, pdfFileName } from '@/lib/exportFile'
import { fontsForExport } from '@/lib/fonts'
import type { TextObject, CompressionPreset, CompressionResult } from '@margin/pdf-core'

const emit = defineEmits<{ close: [] }>()

const doc = useDocumentStore()
const edits = useEditsStore()
const surface = ref<HTMLElement | null>(null)
useFocusTrap(surface, { onEscape: () => emit('close') })

const PRESETS: Array<{ id: CompressionPreset; label: string; note: string }> = [
  { id: 'light', label: 'Light', note: 'Barely visible change' },
  { id: 'balanced', label: 'Balanced', note: 'Good for sharing and email' },
  { id: 'small', label: 'Smallest', note: 'Visible softening of photos' },
]

const preset = ref<CompressionPreset>('balanced')
const result = ref<CompressionResult | undefined>(undefined)
const busy = ref(false)
const error = ref('')

const mb = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`

const saved = computed(() => {
  const r = result.value
  if (!r || r.keptOriginal) return 0
  return Math.round((1 - r.after / r.before) * 100)
})

/**
 * Measure before committing.
 *
 * The trade is quality for bytes and only the user knows which they want,
 * so the actual numbers are produced first and the download is a separate
 * decision. This costs a full export, which is why it is on demand rather
 * than recomputed as the preset changes.
 */
async function estimate(): Promise<void> {
  busy.value = true
  error.value = ''
  result.value = undefined
  try {
    const families = Object.values(edits.doc.objects)
      .filter((o) => o.kind === 'text')
      .map((o) => (o as TextObject).fontFamily)
    const fonts = await fontsForExport(families)
    result.value = await getPdfClient().compress(preset.value, edits.doc, fonts)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'This document could not be compressed.'
  } finally {
    busy.value = false
  }
}

function download(): void {
  const r = result.value
  if (!r) return
  downloadBytes(r.bytes, pdfFileName(doc.fileName))
  emit('close')
}

function choose(next: CompressionPreset): void {
  preset.value = next
  // The old numbers describe the old preset, and leaving them on screen
  // while a different one is selected is the kind of small lie that makes
  // people distrust every other number in the app.
  result.value = undefined
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Make the file smaller"
    data-compress-dialog
    @click.self="emit('close')"
  >
    <div
      ref="surface"
      tabindex="-1"
      class="my-8 flex w-full max-w-md flex-col gap-4 rounded-panel bg-surface p-5 shadow-high"
    >
      <h2 class="text-[17px] font-medium">Make the file smaller</h2>

      <!--
        Named for the outcome, not the mechanism. Someone choosing
        "Smallest" is trading quality for bytes and knows it; someone
        choosing "JPEG quality 45" is being asked to do arithmetic.
      -->
      <div class="flex flex-col gap-1" role="group" aria-label="How much">
        <label
          v-for="p in PRESETS"
          :key="p.id"
          class="flex items-center gap-2 rounded-control border p-2 text-[13px]"
          :class="preset === p.id ? 'border-accent bg-accent/5' : 'border-border'"
        >
          <input
            type="radio"
            name="compression-preset"
            class="accent-accent"
            :data-preset="p.id"
            :checked="preset === p.id"
            @change="choose(p.id)"
          >
          <span class="font-medium">{{ p.label }}</span>
          <span class="text-text-subtle">{{ p.note }}</span>
        </label>
      </div>

      <p class="text-[12px] text-text-subtle">
        Only photographs are affected. Text and drawings are untouched, so a
        document without photos will not get much smaller.
      </p>

      <div v-if="result" data-compress-result class="text-[13px]">
        <!--
          The honest outcome for an already-small file. Reporting "0% saved"
          would read as work done badly; saying the original is already
          smaller says what actually happened.
        -->
        <p v-if="result.keptOriginal" data-compress-kept class="text-text-muted">
          This file is already as small as it is going to get — compressing it
          would make it <strong>bigger</strong>, so there is nothing to download.
        </p>
        <p v-else class="text-text-muted">
          {{ mb(result.before) }} → <strong class="text-text">{{ mb(result.after) }}</strong>
          <span data-compress-saved> ({{ saved }}% smaller)</span>
          <span v-if="result.imagesRecompressed === 0" class="block text-text-subtle">
            No photographs were found, so the saving comes from the file’s
            structure alone.
          </span>
        </p>
      </div>

      <p v-if="error" data-compress-error class="text-[13px] text-danger">{{ error }}</p>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" data-compress-cancel @click="emit('close')">Cancel</Button>
        <Button
          v-if="!result"
          variant="primary"
          data-compress-estimate
          :loading="busy"
          @click="estimate"
        >Check the size</Button>
        <Button
          v-else
          variant="primary"
          data-compress-download
          :disabled="result.keptOriginal"
          @click="download"
        >Download</Button>
      </div>
    </div>
  </div>
</template>
