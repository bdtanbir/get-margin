<script setup lang="ts">
import { ref, computed } from 'vue'
import { useDropZone } from '@vueuse/core'
import { FileUp } from 'lucide-vue-next'
import Button from '@/ui/Button.vue'
import { useDocumentStore } from '@/stores/document'
import { MAX_BYTES, MAX_PAGES } from '@/lib/limits'

const doc = useDocumentStore()
const zone = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)

const { isOverDropZone } = useDropZone(zone, {
  dataTypes: ['application/pdf'],
  onDrop(files) {
    const file = files?.[0]
    if (file) void doc.openFile(file)
  },
})

const busy = computed(() => doc.status === 'opening')

function pick(): void { input.value?.click() }
function onInput(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) void doc.openFile(file)
  ;(e.target as HTMLInputElement).value = '' // allow re-picking the same file
}
</script>

<template>
  <div
    ref="zone"
    class="flex h-full w-full items-center justify-center p-6 transition-colors duration-base"
    :class="isOverDropZone ? 'bg-accent-subtle' : 'bg-canvas'"
  >
    <div
      class="flex w-full max-w-md flex-col items-center gap-5 rounded-panel border-2 border-dashed
             px-6 py-12 text-center transition-colors duration-base"
      :class="isOverDropZone ? 'border-accent' : 'border-border'"
    >
      <div class="rounded-full bg-surface-sunken p-3 text-text-muted">
        <FileUp :size="24" :stroke-width="1.5" />
      </div>

      <div class="space-y-1">
        <h2 class="text-base font-semibold tracking-tight">Open a PDF</h2>
        <p class="text-[13px] text-text-muted">Drag a file here, or choose one from your device.</p>
      </div>

      <Button variant="primary" :loading="busy" @click="pick">
        {{ busy ? 'Opening…' : 'Choose file' }}
      </Button>

      <input ref="input" type="file" accept="application/pdf,.pdf" class="sr-only" @change="onInput" />

      <p class="text-[12px] text-text-subtle">
        Up to {{ Math.round(MAX_BYTES / 1048576) }} MB and {{ MAX_PAGES }} pages.
        Your file stays on this device.
      </p>

      <p v-if="doc.error" role="alert" class="text-[13px] text-danger">{{ doc.error }}</p>
    </div>
  </div>
</template>
