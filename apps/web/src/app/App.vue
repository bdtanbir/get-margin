<script setup lang="ts">
import { useShell } from '@/lib/breakpoint'
import { useTheme } from '@/lib/theme'
import { useDocumentStore } from '@/stores/document'
import DesktopShell from './layouts/DesktopShell.vue'
import MobileShell from './layouts/MobileShell.vue'
import DropZone from '@/features/document/DropZone.vue'
import PasswordPrompt from '@/features/document/PasswordPrompt.vue'

useTheme()
const { isDesktop } = useShell()
const doc = useDocumentStore()
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
  <PasswordPrompt v-if="doc.status === 'needs-password'" />
  <DropZone v-else-if="doc.status !== 'ready'" />
  <component :is="isDesktop ? DesktopShell : MobileShell" v-else />
</template>
