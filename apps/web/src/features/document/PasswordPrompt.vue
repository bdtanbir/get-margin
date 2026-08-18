<script setup lang="ts">
import { ref } from 'vue'
import { Lock } from 'lucide-vue-next'
import Button from '@/ui/Button.vue'
import { useDocumentStore } from '@/stores/document'

const doc = useDocumentStore()
const password = ref('')
const busy = ref(false)

async function submit(): Promise<void> {
  if (!password.value) return
  busy.value = true
  try {
    await doc.submitPassword(password.value)
  } finally {
    busy.value = false
    // Never keep the value around after an attempt (spec §4: passwords in
    // memory only, and no longer than needed). Cleared unconditionally, on
    // both success and failure — on success the component is about to be
    // torn down anyway (App.vue switches to a shell once doc.status becomes
    // 'ready'), so this is never observable there, but it keeps the
    // invariant true regardless of which branch `submitPassword` took.
    password.value = ''
  }
}
</script>

<template>
  <div class="flex h-dvh w-full items-center justify-center bg-canvas p-6">
    <form
      class="flex w-full max-w-sm flex-col gap-4 rounded-panel border border-border bg-surface p-6 shadow-low"
      @submit.prevent="submit"
    >
      <div class="flex items-center gap-2.5">
        <div class="rounded-full bg-surface-sunken p-2 text-text-muted">
          <Lock :size="18" :stroke-width="1.5" />
        </div>
        <div>
          <h2 class="text-[15px] font-semibold tracking-tight">This PDF is protected</h2>
          <p class="text-[13px] text-text-muted">Enter its password to open it.</p>
        </div>
      </div>

      <label class="sr-only" for="pdf-password">Password</label>
      <input
        id="pdf-password"
        v-model="password"
        type="password"
        autocomplete="off"
        class="h-9 rounded-control border border-border bg-surface-sunken px-2.5 text-sm
               outline-none focus-visible:border-accent"
      />

      <p v-if="doc.error" role="alert" class="text-[13px] text-danger">{{ doc.error }}</p>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" size="sm" @click="doc.reset()">Choose another file</Button>
        <Button variant="primary" size="sm" type="submit" :loading="busy">Open</Button>
      </div>
    </form>
  </div>
</template>
