<script setup lang="ts">
import { ref } from 'vue'
import { FilePlus2 } from 'lucide-vue-next'
import { looksLikePdf } from '@margin/pdf-core'
import IconButton from '@/ui/IconButton.vue'
import Tooltip from '@/ui/Tooltip.vue'
import { useDocumentStore } from '@/stores/document'
import { getPdfClient } from '@/workers/pdfClient'
import { checkFileSize } from '@/lib/limits'
import { sha256Hex } from '@/lib/hash'

const doc = useDocumentStore()
const input = ref<HTMLInputElement | null>(null)
const busy = ref(false)

async function onChange(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file || busy.value) return
  busy.value = true
  doc.error = ''
  try {
    const size = checkFileSize(file.size)
    if (!size.ok) {
      doc.error = size.message
      return
    }

    const buf = await file.arrayBuffer()
    // Magic bytes, not the extension -- the same rule openFile applies.
    if (!looksLikePdf(new Uint8Array(buf.slice(0, 1024)))) {
      doc.error = 'That file is not a PDF. Check the file and try again.'
      return
    }

    // Hash before the transfer below neuters the buffer.
    const hash = await sha256Hex(buf)
    const added = await getPdfClient().addSource(new Uint8Array(buf))

    doc.addSource({
      id: added.sourceId,
      name: file.name,
      size: file.size,
      hash,
      geometries: added.geometries,
    })
  } catch (err) {
    doc.error = err instanceof Error ? err.message : 'Could not add that PDF.'
  } finally {
    busy.value = false
    if (input.value) input.value.value = ''
  }
}
</script>

<template>
  <Tooltip content="Add a PDF" side="bottom">
    <IconButton
      size="sm"
      label="Add PDF"
      data-add-source
      :disabled="busy"
      @click="input?.click()"
    >
      <FilePlus2 :size="15" :stroke-width="1.5" />
    </IconButton>
  </Tooltip>
  <input
    ref="input"
    type="file"
    accept="application/pdf,.pdf"
    class="sr-only"
    tabindex="-1"
    aria-hidden="true"
    @change="onChange"
  />
</template>
