<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useFocusTrap } from '@/lib/useFocusTrap'
import Button from '@/ui/Button.vue'
import { useEditsStore } from '@/stores/edits'
import { getPdfClient } from '@/workers/pdfClient'
import { EMPTY_METADATA, type DocumentMetadata } from '@margin/pdf-core'

const emit = defineEmits<{ close: [] }>()

const edits = useEditsStore()
const surface = ref<HTMLElement | null>(null)
useFocusTrap(surface, { onEscape: () => emit('close') })

const form = ref<DocumentMetadata>({ ...EMPTY_METADATA })
const loaded = ref(false)

const FIELDS: Array<{ key: keyof DocumentMetadata; label: string }> = [
  { key: 'title', label: 'Title' },
  { key: 'author', label: 'Author' },
  { key: 'subject', label: 'Subject' },
  { key: 'keywords', label: 'Keywords' },
  { key: 'creator', label: 'Created with' },
]

const stripping = computed(() => edits.doc.stripMetadata === true)

/**
 * Load the SOURCE document's description, unless the user has already
 * changed it in this session.
 *
 * Their edit wins: reading over it would silently discard what they typed
 * the moment they reopened the dialog.
 */
onMounted(async () => {
  const pending = edits.doc.metadata
  if (pending) {
    form.value = { ...pending }
    loaded.value = true
    return
  }
  try {
    form.value = await getPdfClient().metadata()
  } catch {
    // A document whose description cannot be read is still editable; the
    // empty form is the honest starting point.
  }
  loaded.value = true
})

function apply(): void {
  edits.applyOp(
    { type: 'setMetadata', metadata: { ...form.value } },
    'Edit document details',
  )
  // Setting a description and asking for everything to be stripped are
  // contradictory, so choosing one clears the other rather than leaving the
  // export to decide.
  if (stripping.value) {
    edits.applyOp({ type: 'setStripMetadata', strip: false }, 'Edit document details')
  }
  emit('close')
}

function strip(): void {
  edits.withTransaction('Remove document details', () => {
    edits.applyOp({ type: 'setStripMetadata', strip: true }, 'Remove document details')
    edits.applyOp({ type: 'setMetadata', metadata: undefined }, 'Remove document details')
  })
  form.value = { ...EMPTY_METADATA }
  emit('close')
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Document details"
    data-metadata-dialog
    @click.self="emit('close')"
  >
    <div
      ref="surface"
      tabindex="-1"
      class="my-8 flex w-full max-w-md flex-col gap-4 rounded-panel bg-surface p-5 shadow-high"
    >
      <h2 class="text-[17px] font-medium">Document details</h2>

      <p
        v-if="stripping"
        data-metadata-stripping
        class="rounded-control border border-border bg-surface-sunken p-2 text-[12px] text-text-muted"
      >
        This document’s details will be removed when you export it. Saving
        anything below will keep them instead.
      </p>

      <label v-for="f in FIELDS" :key="f.key" class="flex flex-col gap-1">
        <span class="text-[13px] text-text-muted">{{ f.label }}</span>
        <input
          v-model="form[f.key]"
          type="text"
          :data-metadata-field="f.key"
          class="min-h-9 rounded-control border border-border bg-surface-sunken px-2 text-[13px]"
        >
      </label>

      <!--
        Named for what it protects against rather than for the format's
        term. "Metadata" is a word about PDFs; "who made it and when" is
        what the user is deciding to remove.
      -->
      <p class="text-[12px] text-text-subtle">
        These travel with the file. Removing them also removes the document’s
        creation date and its identifier, which would otherwise link this file
        to other versions of it.
      </p>

      <div class="flex justify-between gap-2">
        <Button variant="danger" data-metadata-strip @click="strip">
          Remove all details
        </Button>
        <div class="flex gap-2">
          <Button variant="ghost" data-metadata-cancel @click="emit('close')">Cancel</Button>
          <Button variant="primary" data-metadata-apply @click="apply">Save</Button>
        </div>
      </div>
    </div>
  </div>
</template>
