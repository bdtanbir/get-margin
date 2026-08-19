<script setup lang="ts">
import { ref, computed } from 'vue'
import { useFocusTrap } from '@/lib/useFocusTrap'
import Button from '@/ui/Button.vue'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { getPdfClient } from '@/workers/pdfClient'
import { downloadBytes, pdfFileName } from '@/lib/exportFile'
import { fontsForExport } from '@/lib/fonts'
import type { TextObject, PermissionName } from '@margin/pdf-core'

const emit = defineEmits<{ close: [] }>()

const doc = useDocumentStore()
const edits = useEditsStore()
const surface = ref<HTMLElement | null>(null)
useFocusTrap(surface, { onEscape: () => emit('close') })

const password = ref('')
const confirm = ref('')
const busy = ref(false)
const error = ref('')

/**
 * Granted, not denied.
 *
 * The dialog asks what the reader MAY do, because that is how someone
 * thinks about a document they are sending out. The mask is built from
 * exactly these, so anything unticked is denied -- there is no third state
 * and nothing inherited from the source document.
 */
const PERMISSIONS: Array<{ id: PermissionName; label: string }> = [
  { id: 'print', label: 'Print' },
  { id: 'copy', label: 'Copy text' },
  { id: 'edit', label: 'Change the document' },
  { id: 'annotate', label: 'Add comments' },
  { id: 'form', label: 'Fill in forms' },
  { id: 'assemble', label: 'Add or remove pages' },
  { id: 'accessibility', label: 'Read with a screen reader' },
  { id: 'printHighQuality', label: 'Print at full quality' },
]

/**
 * Everything allowed by default.
 *
 * A protect dialog whose defaults quietly forbid printing and screen
 * readers would produce documents people cannot use, from an action they
 * read as "add a password". Restrictions should be chosen, not inherited
 * from a default.
 */
const granted = ref<Set<PermissionName>>(new Set(PERMISSIONS.map((p) => p.id)))

function toggle(id: PermissionName): void {
  const next = new Set(granted.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  granted.value = next
}

const mismatch = computed(() => confirm.value !== '' && password.value !== confirm.value)
const canApply = computed(() =>
  !busy.value && password.value !== '' && password.value === confirm.value,
)

async function apply(): Promise<void> {
  if (!canApply.value) return
  busy.value = true
  error.value = ''
  doc.error = ''
  try {
    const families = Object.values(edits.doc.objects)
      .filter((o) => o.kind === 'text')
      .map((o) => (o as TextObject).fontFamily)
    const fonts = await fontsForExport(families)

    const bytes = await getPdfClient().save(
      edits.doc, fonts, undefined, undefined,
      {
        userPassword: password.value,
        // No separate owner password. protectedSave falls back to the user
        // password, which is what a document with one password should mean:
        // whoever can open it can change its permissions. Two password
        // fields would ask a consumer editor's users to understand a
        // distinction that mostly exists for publishers.
        ownerPassword: '',
        permissions: [...granted.value],
      },
    )
    downloadBytes(bytes, pdfFileName(doc.fileName))
    emit('close')
  } catch (e) {
    // protectedSave throws rather than returning an unprotected file, so a
    // failure here means NO file was downloaded -- which is the outcome to
    // report, and the reason this never falls back to a plain save.
    error.value = e instanceof Error ? e.message : 'The document could not be protected.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Protect with a password"
    data-protect-dialog
    @click.self="emit('close')"
  >
    <div
      ref="surface"
      tabindex="-1"
      class="my-8 flex w-full max-w-md flex-col gap-4 rounded-panel bg-surface p-5 shadow-high"
    >
      <h2 class="text-[17px] font-medium">Protect with a password</h2>

      <label class="flex flex-col gap-1">
        <span class="text-[13px] text-text-muted">Password to open the document</span>
        <input
          v-model="password"
          type="password"
          autocomplete="new-password"
          data-protect-password
          class="min-h-9 rounded-control border border-border bg-surface-sunken px-2 text-[13px]"
        >
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-[13px] text-text-muted">Type it again</span>
        <input
          v-model="confirm"
          type="password"
          autocomplete="new-password"
          data-protect-confirm
          class="min-h-9 rounded-control border border-border bg-surface-sunken px-2 text-[13px]"
        >
        <!--
          There is no recovery. Nothing in this app, and nothing anywhere
          else, can open the file if the password is lost -- which is the
          point of real encryption and worth saying before it happens
          rather than after.
        -->
        <span v-if="mismatch" data-protect-mismatch class="text-[12px] text-danger">
          Those do not match.
        </span>
        <span v-else class="text-[12px] text-text-subtle">
          Keep it somewhere safe. A lost password cannot be recovered — not by
          this app, and not by anyone.
        </span>
      </label>

      <fieldset class="flex flex-col gap-2">
        <legend class="text-[13px] text-text-muted">The reader may</legend>
        <div class="grid grid-cols-2 gap-1">
          <label
            v-for="p in PERMISSIONS"
            :key="p.id"
            class="flex items-center gap-2 text-[13px]"
          >
            <input
              type="checkbox"
              class="accent-accent"
              :data-permission="p.id"
              :checked="granted.has(p.id)"
              @change="toggle(p.id)"
            >
            {{ p.label }}
          </label>
        </div>
        <!--
          THE CAVEAT, and it is not a footnote. PDF permissions are a
          REQUEST to the viewer, not a property of the file: a reader that
          chooses to ignore them can print, copy, and edit freely, and
          several do. Someone who believes "no copy" is a technical
          guarantee is being misled by omission, so the dialog says which
          half is enforced and which half is asked for.
        -->
        <p data-protect-caveat class="text-[12px] text-text-muted">
          The password is real encryption — without it the file cannot be opened.
          These permissions are different: they are a request to the PDF reader,
          and a reader that ignores them can do any of it anyway. Treat them as a
          statement of intent, not a lock.
        </p>
      </fieldset>

      <p v-if="error" data-protect-error class="text-[13px] text-danger">{{ error }}</p>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" data-protect-cancel @click="emit('close')">Cancel</Button>
        <Button
          variant="primary"
          data-protect-apply
          :loading="busy"
          :disabled="!canApply"
          @click="apply"
        >Download protected</Button>
      </div>
    </div>
  </div>
</template>
