<script setup lang="ts">
import { computed, ref } from 'vue'
import { History } from 'lucide-vue-next'
import Button from '@/ui/Button.vue'
import { useAutosaveStore } from '@/stores/autosave'
import { useDocumentStore } from '@/stores/document'

const autosave = useAutosaveStore()
const doc = useDocumentStore()
const failed = ref('')

const when = computed(() => {
  const at = autosave.offered?.savedAt
  if (!at) return ''
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 1) return 'a moment ago'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
})

function accept(): void {
  try {
    autosave.restore()
  } catch (e) {
    // A record this build cannot represent -- from a newer version. Say so
    // rather than silently leaving the document blank.
    failed.value = e instanceof Error ? e.message : 'Those edits could not be restored.'
    doc.error = failed.value
  }
}
</script>

<template>
  <!--
    An OFFER, never automatic. Restoring silently would mean a user who
    deliberately started over finds their old annotations back with no
    explanation, and no way to tell which state is which.
  -->
  <div
    v-if="autosave.offered"
    data-restore-prompt
    role="status"
    class="fixed inset-x-0 top-16 z-50 mx-auto flex w-full max-w-md items-start gap-3
           rounded-panel border border-border bg-surface-raised p-3 shadow-high"
  >
    <History :size="18" :stroke-width="1.5" class="mt-0.5 shrink-0 text-accent" />
    <div class="flex min-w-0 flex-1 flex-col gap-2">
      <p class="text-[13px] text-text">
        You have unsaved edits to this file from <strong>{{ when }}</strong>.
      </p>
      <p class="text-[12px] text-text-subtle">
        They were kept on this device. The file itself was never uploaded or stored.
      </p>
      <div class="flex gap-2">
        <Button size="sm" data-restore-accept @click="accept">Restore them</Button>
        <Button size="sm" variant="ghost" data-restore-discard @click="autosave.discard()">
          Discard
        </Button>
        <Button size="sm" variant="ghost" data-restore-dismiss @click="autosave.dismiss()">
          Not now
        </Button>
      </div>
    </div>
  </div>
</template>
