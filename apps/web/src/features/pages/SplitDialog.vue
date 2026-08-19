<script setup lang="ts">
import { ref, computed } from 'vue'
import Button from '@/ui/Button.vue'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { getPdfClient } from '@/workers/pdfClient'
import { parseRanges, partName } from '@/lib/pageRanges'
import { zipFiles } from '@/lib/zip'
import { downloadBytes } from '@/lib/exportFile'
import { fontsForExport } from '@/lib/fonts'
import type { TextObject } from '@margin/pdf-core'

const doc = useDocumentStore()
const edits = useEditsStore()

const emit = defineEmits<{ close: [] }>()

const input = ref('')
const busy = ref(false)
const error = ref('')

/** Live preview of what will be produced, or the parse error. */
const groups = computed<number[][]>(() => {
  if (!input.value.trim()) return []
  try {
    return parseRanges(input.value, doc.pageCount)
  } catch {
    return []
  }
})

const summary = computed(() => {
  if (!input.value.trim()) return ''
  try {
    const parsed = parseRanges(input.value, doc.pageCount)
    const parts = parsed
      .map((g) => (g.length === 1 ? `page ${g[0]! + 1}` : `pages ${g[0]! + 1}–${g[g.length - 1]! + 1}`))
      .join(', ')
    return `${parsed.length} ${parsed.length === 1 ? 'file' : 'files'}: ${parts}`
  } catch (e) {
    return e instanceof Error ? e.message : ''
  }
})

/**
 * Export one group by reusing the ORDINARY write path with a narrowed
 * pageOrder, rather than adding a second export implementation. Every
 * guarantee the main export has -- assembly tiers, annotation survival,
 * font embedding -- comes along for free.
 */
async function exportGroup(pages: number[], fonts: Map<string, Uint8Array>): Promise<Uint8Array> {
  const order = pages.map((i) => doc.pageOrder[i]).filter((id): id is string => !!id)
  const narrowed = {
    ...edits.doc,
    pageOrder: order,
    // Objects on pages that are not in this part would be dropped by the
    // writer anyway; filtering here keeps the payload small.
    objects: Object.fromEntries(
      Object.entries(edits.doc.objects).filter(([, o]) => order.includes(o.pageId)),
    ),
  }
  return getPdfClient().save(narrowed, fonts)
}

async function run(): Promise<void> {
  if (busy.value) return
  error.value = ''
  let parsed: number[][]
  try {
    parsed = parseRanges(input.value, doc.pageCount)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'That is not a page range.'
    return
  }

  busy.value = true
  try {
    const families = Object.values(edits.doc.objects)
      .filter((o) => o.kind === 'text')
      .map((o) => (o as TextObject).fontFamily)
    const fonts = await fontsForExport(families)

    const parts = await Promise.all(
      parsed.map(async (pages) => ({
        name: partName(doc.fileName, pages),
        data: await exportGroup(pages, fonts),
      })),
    )

    if (parts.length === 1) {
      // A single part is a plain PDF, not a zip of one thing.
      downloadBytes(parts[0]!.data, parts[0]!.name)
    } else {
      downloadBytes(await zipFiles(parts), `${doc.fileName.replace(/\.pdf$/i, '')}-split.zip`)
    }
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not split this PDF.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Split or extract pages"
    data-split-dialog
    @click.self="emit('close')"
  >
    <div class="flex w-full max-w-md flex-col gap-3 rounded-panel bg-surface p-4 shadow-high">
      <h2 class="text-[15px] font-medium">Split or extract pages</h2>

      <label class="flex flex-col gap-1 text-[13px] text-text-muted">
        Pages
        <input
          v-model="input"
          data-split-input
          type="text"
          placeholder="1-3, 5, 8-"
          class="min-h-11 rounded-control border border-border bg-surface-sunken px-3 text-[14px] text-text"
        />
      </label>

      <p class="text-[12px] text-text-subtle" data-split-summary>
        {{ summary || `This document has ${doc.pageCount} pages. Each group becomes its own file.` }}
      </p>

      <p v-if="error" class="text-[12px] text-danger" data-split-error>{{ error }}</p>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" data-split-cancel @click="emit('close')">Cancel</Button>
        <Button data-split-run :loading="busy" :disabled="groups.length === 0" @click="run">
          {{ groups.length > 1 ? 'Split' : 'Extract' }}
        </Button>
      </div>
    </div>
  </div>
</template>
