<script setup lang="ts">
import { ref } from 'vue'
import { X } from 'lucide-vue-next'
import Button from '@/ui/Button.vue'
import IconButton from '@/ui/IconButton.vue'
import { clearEdits } from '@/lib/autosaveDb'
import { clearSignatures } from '@/features/signature/signatureStore'
import { MAX_BYTES, MAX_PAGES } from '@/lib/limits'

const emit = defineEmits<{ close: [] }>()
const cleared = ref(false)

/**
 * Clear everything this app has stored. Deliberately reachable from the
 * page that lists it: telling someone what you keep without offering to
 * delete it is half an answer.
 */
async function clearAll(): Promise<void> {
  await Promise.all([clearEdits(), clearSignatures()])
  try {
    localStorage.removeItem('get-margin-theme')
  } catch {
    // Private mode; nothing was stored to begin with.
  }
  cleared.value = true
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Privacy"
    data-privacy-page
    @click.self="emit('close')"
  >
    <div class="my-8 flex w-full max-w-lg flex-col gap-4 rounded-panel bg-surface p-5 shadow-high">
      <div class="flex items-start justify-between gap-3">
        <h2 class="text-[17px] font-medium">Privacy</h2>
        <IconButton size="sm" label="Close" data-privacy-close @click="emit('close')">
          <X :size="16" :stroke-width="1.5" />
        </IconButton>
      </div>

      <section class="flex flex-col gap-2">
        <h3 class="text-[14px] font-medium">Your files never leave this device</h3>
        <p class="text-[13px] text-text-muted">
          Every PDF you open is read, edited, and exported inside this browser tab.
          Nothing is uploaded, and there is no server to upload it to — this app is
          a static site with no backend, no accounts, and no analytics on your
          documents.
        </p>
      </section>

      <!--
        The honest half. Claiming "nothing is stored" would be false, and a
        privacy page that is false about the easy part is not worth reading.
        Every item here is something the code actually writes; see
        lib/autosaveDb.ts, features/signature/signatureStore.ts, lib/theme.ts.
      -->
      <section class="flex flex-col gap-2">
        <h3 class="text-[14px] font-medium">What is stored on this device</h3>
        <ul class="flex list-disc flex-col gap-2 pl-5 text-[13px] text-text-muted">
          <li>
            <strong>Your edits.</strong> Annotations, shapes, text and page changes are
            saved as you work, so a crashed tab does not lose an hour of it. They are
            matched back to a file by a fingerprint of its contents — which means
            <em>the PDF itself is never stored</em>, only what you did to it. You are
            asked before anything is restored.
          </li>
          <li>
            <strong>Saved signatures</strong>, and only if you tick the box that says so.
            Unticked by default.
          </li>
          <li><strong>Your light or dark theme preference.</strong></li>
        </ul>
      </section>

      <section class="flex flex-col gap-2">
        <h3 class="text-[14px] font-medium">What is not stored</h3>
        <p class="text-[13px] text-text-muted">
          The PDFs themselves, their text, their images, and anything identifying you.
          Files up to {{ mb(MAX_BYTES) }} and {{ MAX_PAGES }} pages are held in memory
          while open and discarded when you close the tab.
        </p>
      </section>

      <section class="flex flex-col gap-2">
        <h3 class="text-[14px] font-medium">One more thing about downloads</h3>
        <p class="text-[13px] text-text-muted">
          Exported PDFs have any embedded JavaScript and automatic actions removed,
          so a file you pass on cannot carry a script that came in with the original.
          If the original used scripts for form validation, those go too.
        </p>
      </section>

      <div class="flex items-center gap-3">
        <Button variant="danger" data-privacy-clear @click="clearAll">
          Clear everything stored
        </Button>
        <span v-if="cleared" data-privacy-cleared class="text-[13px] text-text-muted">
          Cleared.
        </span>
      </div>
    </div>
  </div>
</template>
