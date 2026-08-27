import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

/**
 * Which document-wide dialog is open, if any.
 *
 * Phase 6 adds five of these -- stamping, protection, metadata,
 * compression, find -- and threading five booleans from App.vue through to
 * five call sites would mean five chances to leave one open. One value also
 * makes the invariant free: at most one modal at a time, which is what
 * focus trapping assumes.
 *
 * NOT in edit history. Which dialog is on screen is not a document edit,
 * and undoing a stamp should not reopen the dialog that made it.
 */
export type DialogId =
  | 'stamp' | 'protect' | 'metadata' | 'compress' | 'find' | 'images' | 'help'
  // Separate from 'help' rather than a section inside it: the shortcut
  // table and eighteen tool descriptions are different questions, and
  // stacking them made one dialog nobody scrolls to the bottom of.
  | 'tools-guide'

export const useDialogsStore = defineStore('dialogs', () => {
  const open = ref<DialogId | null>(null)

  return {
    open: computed(() => open.value),
    isOpen: (id: DialogId) => open.value === id,
    show(id: DialogId): void { open.value = id },
    close(): void { open.value = null },
  }
})
