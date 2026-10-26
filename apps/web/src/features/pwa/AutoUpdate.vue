<script setup lang="ts">
import { RefreshCw } from 'lucide-vue-next'
import Button from '@/ui/Button.vue'
import { usePwaUpdates } from '@/lib/pwa/updates'

const updates = usePwaUpdates()
</script>

<template>
  <!--
    Bottom of the screen, not the top: RestorePrompt already owns `top-16`,
    and the two can be on screen at the same moment -- a user returns to a
    file they were editing on a day a new build shipped. Stacking them
    would hide one behind the other.

    `role="status"` rather than `alert`: a newer version being available is
    not an interruption, and an assertive announcement would cut across
    whatever the screen reader was saying about the document.
  -->
  <div
    v-if="updates.needsRefresh.value"
    data-pwa-update
    role="status"
    class="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-full max-w-md items-start gap-3
           rounded-panel border border-border bg-surface-raised p-3 shadow-high"
  >
    <RefreshCw :size="18" :stroke-width="1.5" class="mt-0.5 shrink-0 text-accent" />
    <div class="flex min-w-0 flex-1 flex-col gap-2">
      <p class="text-[13px] text-text">A new version of get-margin is ready.</p>
      <p class="text-[12px] text-text-subtle">
        Reloading closes the document you have open. Any edits you have not exported
        are kept on this device and offered back when you reopen the file.
      </p>
      <div class="flex gap-2">
        <Button size="sm" data-pwa-update-accept @click="updates.apply()">Reload</Button>
        <Button size="sm" variant="ghost" data-pwa-update-dismiss @click="updates.dismiss()">
          Not now
        </Button>
      </div>
    </div>
  </div>
</template>
