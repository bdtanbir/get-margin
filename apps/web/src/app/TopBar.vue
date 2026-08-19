<script setup lang="ts">
import { computed, ref } from 'vue'
import { Download, Sun, Moon, Monitor, PanelLeft, Undo2, Redo2, ShieldCheck } from 'lucide-vue-next'
import Button from '@/ui/Button.vue'
import IconButton from '@/ui/IconButton.vue'
import Tooltip from '@/ui/Tooltip.vue'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useAutosaveStore } from '@/stores/autosave'
import { useTheme } from '@/lib/theme'
import { getPdfClient } from '@/workers/pdfClient'
import { downloadBytes, pdfFileName } from '@/lib/exportFile'
import { fontsForExport } from '@/lib/fonts'
import PrivacyPage from '@/features/document/PrivacyPage.vue'
import type { TextObject, StrippedContent } from '@margin/pdf-core'

const props = defineProps<{ compact?: boolean; panelOpen?: boolean }>()
const emit = defineEmits<{ togglePanel: [] }>()

const doc = useDocumentStore()
const edits = useEditsStore()
const autosave = useAutosaveStore()
const { choice, cycle } = useTheme()
const icon = { light: Sun, dark: Moon, system: Monitor }

const saving = ref(false)

/**
 * Determinate progress, shown only for documents big enough that the export
 * takes visibly long. Below that threshold a bar would flash and vanish,
 * which reads as a glitch rather than as feedback.
 */
const PROGRESS_FROM_PAGES = 20
const progress = ref<{ done: number; total: number } | undefined>(undefined)

/**
 * What the last export removed, if anything.
 *
 * Surfaced AFTER the download rather than as a confirmation before it: the
 * removal is not optional (spec 4A) so there is nothing to confirm, and
 * blocking a succeeded download on an acknowledgement would be theatre.
 * But it is a real change to the user's file and they should not have to
 * discover it themselves.
 */
const stripped = ref<StrippedContent | undefined>(undefined)
const privacyOpen = ref(false)

const strippedMessage = computed(() => {
  const s = stripped.value
  if (!s) return ''
  const parts: string[] = []
  if (s.openAction) parts.push('a script that would have run when the file opened')
  if (s.documentJavaScript) parts.push('document-level JavaScript')
  if (s.catalogActions || s.pageActions > 0) parts.push('automatic page actions')
  return `Removed ${parts.join(', ')}. If the original had form-field scripts, those are gone too.`
})

const progressLabel = computed(() => {
  const p = progress.value
  return p ? `Exporting ${p.done} of ${p.total}` : 'Exporting'
})

async function download(): Promise<void> {
  if (saving.value) return
  saving.value = true
  progress.value = undefined
  stripped.value = undefined
  // Clear any previous failure, so a retry does not sit under a stale
  // message that describes an error the user has already worked around.
  doc.error = ''
  try {
    // The worker embeds font bytes it is given; it cannot fetch them
    // itself. Only the families actually in use are sent -- shipping all
    // five would add ~340KB of fetches to a document that uses one.
    const families = Object.values(edits.doc.objects)
      .filter((o) => o.kind === 'text')
      .map((o) => (o as TextObject).fontFamily)
    const fonts = await fontsForExport(families)
    const bytes = await getPdfClient().save(
      edits.doc,
      fonts,
      doc.pageCount >= PROGRESS_FROM_PAGES
        ? (done, total) => { progress.value = { done, total } }
        : undefined,
      (found) => {
        // Only worth saying when something actually went.
        if (found.openAction || found.documentJavaScript || found.catalogActions || found.pageActions > 0) {
          stripped.value = found
        }
      },
    )
    downloadBytes(bytes, pdfFileName(doc.fileName))
  } catch (e) {
    // NEVER download a partial file. replay() throws rather than returning
    // a document missing an edit, and this branch is the only reason the
    // download above is skipped -- a PDF that silently dropped the user's
    // signature is worse than a failed download, because they will not
    // notice the omission.
    doc.error = e instanceof Error ? e.message : 'Could not export this PDF.'
  } finally {
    // Reset unconditionally, including after a failure, so the button
    // returns to idle and the user can retry.
    saving.value = false
    progress.value = undefined
  }
}
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
      Autosave state, said plainly. An editor that saves silently leaves
      the user unsure whether closing the tab is safe, and it is the signal
      e2e waits on rather than guessing at the debounce.
    -->
    <span
      v-if="autosave.state"
      :data-autosave-state="autosave.state"
      class="text-[12px] text-text-subtle"
      role="status"
      aria-live="polite"
    >{{ autosave.state === 'saving' ? 'Saving…' : 'Saved' }}</span>

    <!--
      Undo/redo as buttons as well as shortcuts: the mobile shell has no
      physical keyboard, and a history stack reachable only by Cmd+Z is
      unreachable for a whole class of users.
    -->
    <Tooltip content="Undo" shortcut="⌘Z" side="bottom">
      <IconButton
        label="Undo"
        size="sm"
        data-undo
        :disabled="!edits.canUndo"
        @click="edits.undo()"
      >
        <Undo2 :size="16" :stroke-width="1.5" />
      </IconButton>
    </Tooltip>
    <Tooltip content="Redo" shortcut="⇧⌘Z" side="bottom">
      <IconButton
        label="Redo"
        size="sm"
        data-redo
        :disabled="!edits.canRedo"
        @click="edits.redo()"
      >
        <Redo2 :size="16" :stroke-width="1.5" />
      </IconButton>
    </Tooltip>

    <Tooltip content="Privacy" side="bottom">
      <IconButton label="Privacy" size="sm" data-open-privacy @click="privacyOpen = true">
        <ShieldCheck :size="16" :stroke-width="1.5" />
      </IconButton>
    </Tooltip>
    <PrivacyPage v-if="privacyOpen" @close="privacyOpen = false" />

    <Tooltip content="Download PDF" side="bottom">
      <Button
        variant="primary"
        size="sm"
        aria-label="Download"
        data-download
        :loading="saving"
        :disabled="!doc.isReady"
        @click="download"
      >
        <Download :size="15" :stroke-width="1.5" />
        <!--
          The determinate count replaces the label only while it exists, so
          short exports never flash a bar that reads as a glitch. aria-live
          announces it without stealing focus from wherever the user is.
        -->
        <span v-if="!props.compact" data-download-label>
          {{ saving && progress ? progressLabel : 'Download' }}
        </span>
      </Button>
    </Tooltip>
    <span v-if="saving && progress" class="sr-only" role="status" aria-live="polite">
      {{ progressLabel }}
    </span>

    <div
      v-if="stripped"
      data-stripped-notice
      role="status"
      class="absolute right-3 top-16 z-50 max-w-sm rounded-panel border border-border
             bg-surface-raised p-3 text-[12px] text-text-muted shadow-high"
    >
      {{ strippedMessage }}
      <button
        type="button"
        class="mt-2 block text-[12px] text-accent"
        data-stripped-dismiss
        @click="stripped = undefined"
      >Dismiss</button>
    </div>
  </header>
</template>
