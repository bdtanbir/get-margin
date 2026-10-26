<script setup lang="ts">
import { watchEffect } from 'vue'
import { usePwaUpdates } from '@/lib/pwa/updates'
import { useDocumentStore } from '@/stores/document'

/**
 * Takes a new version of the app by itself -- no "Reload" button.
 *
 * It used to ask. The user's request was that a new version should simply
 * arrive. What it must not do is reload under an OPEN document: the file
 * itself is not kept across a reload (only the edits are, and only offered
 * back once the file is opened again), so reloading mid-edit would close
 * the user's work in front of them.
 *
 * So it reloads the moment it is safe: straight away when no document is
 * open, and otherwise as soon as the open one is closed. Nothing is shown
 * either way.
 */
const updates = usePwaUpdates()
const doc = useDocumentStore()

/**
 * Nothing the user would lose: no file, or one that failed to open. Not
 * while a file is opening or waiting for its password -- reloading then
 * would drop the file they just picked.
 */
const idle = (): boolean => doc.status === 'empty' || doc.status === 'error'

watchEffect(() => {
  if (updates.needsRefresh.value && idle()) updates.apply()
})
</script>

<template>
  <!-- Nothing to show: see the comment above. -->
</template>
