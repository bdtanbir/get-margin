<script setup lang="ts">
import { ref, computed } from 'vue'
import { useFocusTrap } from '@/lib/useFocusTrap'
import Button from '@/ui/Button.vue'
import { JOB_TTL_MS } from '@margin/shared'

/**
 * The one place in this product where a file leaves the device.
 *
 * Everything else -- editing, redaction, forms, image export -- happens in
 * the browser tab, and the privacy page says so. A conversion breaks that,
 * and `PLAN.md` §4 requires an explicit per-action consent step naming what
 * is being uploaded and when it is deleted.
 *
 * So this dialog is not a formality to click past. There is no pre-ticked
 * box and no "don't show again": a consent that can be skipped by muscle
 * memory is not consent, and this is the one screen in the product where
 * that distinction is load-bearing rather than pedantic.
 */
const props = defineProps<{
  fileName: string
  fileSize: number
  /** What will be done, in the user's words: "converted to a PDF". */
  operation: string
}>()

const emit = defineEmits<{ confirm: []; cancel: [] }>()

const surface = ref<HTMLElement | null>(null)
useFocusTrap(surface, { onEscape: () => emit('cancel') })

/** Starts false, every time. Not persisted, not remembered, not defaulted. */
const agreed = ref(false)

const size = computed(() => {
  const bytes = props.fileSize
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
})

/**
 * Taken from the server's own TTL rather than written into the sentence.
 *
 * If someone changes the retention window, this copy changes with it. A
 * promise about deletion that is a hardcoded string in the UI is a promise
 * that silently becomes a lie the first time the server is reconfigured.
 */
const window = computed(() => {
  const hours = JOB_TTL_MS / (60 * 60 * 1000)
  if (hours === 1) return 'an hour'
  return `${hours} hours`
})
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Before this file is uploaded"
    data-consent-dialog
    @click.self="emit('cancel')"
  >
    <div
      ref="surface"
      tabindex="-1"
      class="my-8 flex w-full max-w-md flex-col gap-4 rounded-panel bg-surface p-5 shadow-high"
    >
      <h2 class="text-[17px] font-medium">This file will be uploaded</h2>

      <!--
        The file, by name and size. Naming it is the difference between
        consenting to an upload and consenting to the idea of one -- with
        several documents open, "upload the file?" is not a question anyone
        can answer correctly.
      -->
      <p class="text-[13px] text-text">
        <strong data-consent-file>{{ fileName }}</strong>
        <span data-consent-size class="text-text-muted"> ({{ size }})</span>
        will be sent to our server and <span data-consent-operation>{{ operation }}</span>.
      </p>

      <ul class="flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-text-muted">
        <li data-consent-deletion>
          It is deleted as soon as you download the result, and in any case
          within {{ window }} — whether the conversion works or not.
        </li>
        <li data-consent-only>
          This is the only feature in this app that uploads anything. Everything
          else you do here stays on your device.
        </li>
        <li>
          We never store or log the file’s name. You can delete it from the
          server yourself at any point, without waiting.
        </li>
      </ul>

      <!--
        Unticked, always. No "remember this choice" either: the point of a
        per-action consent is that it is per action.
      -->
      <label class="flex items-start gap-2 text-[13px]">
        <input
          v-model="agreed"
          type="checkbox"
          class="mt-0.5 accent-accent"
          data-consent-agree
        >
        <span>I understand this file will be uploaded to a server.</span>
      </label>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" data-consent-cancel @click="emit('cancel')">Cancel</Button>
        <Button
          variant="primary"
          data-consent-confirm
          :disabled="!agreed"
          @click="emit('confirm')"
        >Upload and convert</Button>
      </div>
    </div>
  </div>
</template>
