<script setup lang="ts">
import { Download, Sun, Moon, Monitor, PanelLeft } from 'lucide-vue-next'
import Button from '@/ui/Button.vue'
import IconButton from '@/ui/IconButton.vue'
import Tooltip from '@/ui/Tooltip.vue'
import { useDocumentStore } from '@/stores/document'
import { useTheme } from '@/lib/theme'

const props = defineProps<{ compact?: boolean; panelOpen?: boolean }>()
const emit = defineEmits<{ togglePanel: [] }>()

const doc = useDocumentStore()
const { choice, cycle } = useTheme()
const icon = { light: Sun, dark: Moon, system: Monitor }
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

    <!--
      Export lands in Phase 2; disabled rather than hidden so the layout is
      final. Amendment A4: compact mode drops the visible "Download" text,
      leaving the button icon-only with no accessible name — inconsistent
      with the `IconButton` `label` discipline used everywhere else in this
      app (see IconButton.vue's own `label` prop comment). `aria-label`
      fills that gap in both modes (harmless when the text is also
      present: an explicit `aria-label` simply becomes the accessible name
      instead of the text content, which is identical here).
    -->
    <Button variant="primary" size="sm" disabled aria-label="Download">
      <Download :size="15" :stroke-width="1.5" />
      <span v-if="!props.compact">Download</span>
    </Button>
  </header>
</template>
