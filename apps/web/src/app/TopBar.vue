<script setup lang="ts">
import { ref } from 'vue'
import { Download, Sun, Moon, Monitor, PanelLeft } from 'lucide-vue-next'
import Button from '@/ui/Button.vue'
import IconButton from '@/ui/IconButton.vue'
import Tooltip from '@/ui/Tooltip.vue'
import { useDocumentStore } from '@/stores/document'
import { useTheme } from '@/lib/theme'
import { getPdfClient } from '@/workers/pdfClient'
import { downloadBytes, pdfFileName } from '@/lib/exportFile'

const props = defineProps<{ compact?: boolean; panelOpen?: boolean }>()
const emit = defineEmits<{ togglePanel: [] }>()

const doc = useDocumentStore()
const { choice, cycle } = useTheme()
const icon = { light: Sun, dark: Moon, system: Monitor }

const saving = ref(false)

async function download(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    const bytes = await getPdfClient().save()
    downloadBytes(bytes, pdfFileName(doc.fileName))
  } catch (e) {
    doc.error = e instanceof Error ? e.message : 'Could not export this PDF.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <header
    class="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3"
    role="banner"
  >
    <Tooltip v-if="!props.compact" content="Pages" side="bottom">
      <IconButton size="sm" label="Toggle pages panel" :active="props.panelOpen" @click="emit('togglePanel')">
        <PanelLeft :size="17" :stroke-width="1.5" />
      </IconButton>
    </Tooltip>

    <span v-if="!props.compact" class="text-[13px] font-semibold tracking-tight">get-margin</span>

    <span class="truncate text-[13px] text-text-muted" :class="props.compact ? 'flex-1' : ''">
      {{ doc.fileName || 'No document' }}
    </span>

    <div class="flex-1" />

    <Tooltip :content="`Theme: ${choice}`" side="bottom">
      <IconButton size="sm" :label="`Theme: ${choice}`" @click="cycle()">
        <component :is="icon[choice]" :size="17" :stroke-width="1.5" />
      </IconButton>
    </Tooltip>

    <Tooltip content="Download PDF" side="bottom">
      <Button
        variant="primary"
        size="sm"
        aria-label="Download"
        :loading="saving"
        :disabled="!doc.isReady"
        @click="download"
      >
        <Download :size="15" :stroke-width="1.5" />
        <span v-if="!props.compact">Download</span>
      </Button>
    </Tooltip>
  </header>
</template>
