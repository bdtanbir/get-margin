<script setup lang="ts">
import { useShell } from '@/lib/breakpoint'
import { useTheme } from '@/lib/theme'
import { useDocumentStore } from '@/stores/document'
import DesktopShell from './layouts/DesktopShell.vue'
import MobileShell from './layouts/MobileShell.vue'
import DropZone from '@/features/document/DropZone.vue'

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
    piece is one of exactly three: DropZone below, or whichever shell
    `isDesktop` (apps/web/src/lib/breakpoint.ts) selects.

    Amendment A1: the brief's App.vue also renders PasswordPrompt for
    `doc.status === 'needs-password'`, but that component is Task 21's to
    write — importing it here would break `vite build`/`vue-tsc` for this
    task. Omitted entirely rather than stubbed: DropZone already covers
    every non-ready status, `needs-password` included, because it renders
    `doc.error` regardless of which non-ready status produced it. Task 21
    adds the component and its `v-if` branch together.
  -->
  <DropZone v-if="doc.status !== 'ready'" />
  <component :is="isDesktop ? DesktopShell : MobileShell" v-else />
</template>
