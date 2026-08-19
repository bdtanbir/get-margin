<script setup lang="ts">
import { ref, watch } from 'vue'
import { useToolsStore } from '@/stores/tools'
import { useImageTool } from './useImageTool'

const tools = useToolsStore()
const image = useImageTool()
const input = ref<HTMLInputElement | null>(null)

/**
 * The Image tool has no drag gesture -- there is nothing to draw until a
 * file exists -- so selecting it opens the system picker immediately. This
 * component is the one place that happens, mounted once per shell, rather
 * than each of the rail and the strip growing its own hidden input.
 */
watch(() => tools.active, (tool) => {
  if (tool !== 'image' || !input.value) return
  input.value.value = ''
  input.value.click()
})

async function onChange(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0]
  // Either way the tool goes back to select: with a file, useImageTool hands
  // the placed object to it; without one, staying on a tool whose picker has
  // already closed leaves a button that looks armed and does nothing.
  if (file) await image.place(file)
  else tools.setTool('select')
}
</script>

<template>
  <input
    ref="input"
    type="file"
    accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
    class="hidden"
    aria-hidden="true"
    tabindex="-1"
    @change="onChange"
    @cancel="tools.setTool('select')"
  />
</template>
