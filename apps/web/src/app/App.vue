<script setup lang="ts">
import { useShell } from '@/lib/breakpoint'
import { useTheme } from '@/lib/theme'
import { useDocumentStore } from '@/stores/document'
import DesktopShell from './layouts/DesktopShell.vue'
import MobileShell from './layouts/MobileShell.vue'
import DropZone from '@/features/document/DropZone.vue'
import PasswordPrompt from '@/features/document/PasswordPrompt.vue'
import ErrorBoundary from './ErrorBoundary.vue'
import StampDialog from '@/features/stamp/StampDialog.vue'
import ProtectDialog from '@/features/protect/ProtectDialog.vue'
import { useDialogsStore } from '@/stores/dialogs'
import RestorePrompt from '@/features/document/RestorePrompt.vue'
import CommandPalette from '@/features/command/CommandPalette.vue'

useTheme()
const { isDesktop } = useShell()
const doc = useDocumentStore()
const dialogs = useDialogsStore()

/**
 * Record a boundary's catch on the document store, which is where every
 * other user-facing failure already lands. A caught error that is only
 * rendered inside the boundary is invisible to anything else -- including
 * whatever eventually reports problems.
 */
function record(err: Error): void {
  doc.error = err.message
}
</script>

<template>
  <!--
    Task 20 replaces the single-shell scaffolding (Tasks 15-19, all mounted
    directly here) with DesktopShell/MobileShell: two layout-only shells
    that compose the same feature components (PageList, ZoomPill,
    ThumbnailPanel, DropZone) and read the same stores. This is still the
    app's real root, so it is still where every top-level piece gets
    mounted (naming the mounting parent is the standing rule since a fully
    built DropZone once shipped unmounted with a green suite) — now that
    piece is one of exactly four: PasswordPrompt, DropZone, or whichever
    shell `isDesktop` (apps/web/src/lib/breakpoint.ts) selects.

    Amendment A1: Task 20 deliberately omitted PasswordPrompt here because
    the component didn't exist yet and importing it would have broken
    `vite build`/`vue-tsc` for that task. Task 21 creates the component and
    this branch together, in the same commit. `needs-password` is checked
    first and explicitly, ahead of the general "any non-ready status"
    branch below, so a locked document gets the dedicated password UI
    rather than DropZone's generic "Open a PDF" treatment (which still
    covers every OTHER non-ready status — 'empty', 'opening', 'error' —
    exactly as before; no ErrorState.vue was added, since DropZone already
    renders `doc.error` inline for the 'error' status and a second
    full-screen error treatment would be pure duplication).
  -->
  <!--
    One boundary around the editing shell, so a render or overlay failure
    costs the user that region rather than the whole app: the document
    stays open and the edits stay in the store behind it.

    DropZone and PasswordPrompt are deliberately outside it. They ARE the
    recovery surfaces -- wrapping them would mean a failure in the fallback
    had nowhere left to fall back to.
  -->
  <PasswordPrompt v-if="doc.status === 'needs-password'" />
  <DropZone v-else-if="doc.status !== 'ready'" />
  <ErrorBoundary v-else label="The editor" @captured="record">
    <component :is="isDesktop ? DesktopShell : MobileShell" />
    <!--
      Outside the shells so it survives the desktop/mobile swap, and inside
      the boundary so a failure in it is caught like any other.
    -->
    <RestorePrompt />
    <!--
      An accelerator over commands that already exist and are already
      reachable, which is why it is built last rather than beside them.
    -->
    <CommandPalette />
    <!--
      Document-wide dialogs, mounted once here rather than beside whatever
      happens to open them. They act on the whole file, so there is no
      component that owns them, and a single store value keeps the "at most
      one modal" invariant that focus trapping already assumes.
    -->
    <StampDialog v-if="dialogs.isOpen('stamp')" @close="dialogs.close()" />
    <ProtectDialog v-if="dialogs.isOpen('protect')" @close="dialogs.close()" />
  </ErrorBoundary>
</template>
