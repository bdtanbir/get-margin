import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

/**
 * Whether the command palette is open.
 *
 * Lifted out of CommandPalette.vue so something OTHER than the keyboard can
 * open it. The palette was reachable by ⌘K and by nothing else -- no button,
 * no menu, no hint -- which made every command in it invisible to anyone who
 * had not been told the shortcut.
 *
 * Deliberately NOT folded into the dialogs store. That store holds one id and
 * gets "at most one modal" for free; the palette does not share that
 * invariant (⌘K over an open help panel leaves both up, which is the
 * behaviour that already shipped), and merging them would change it silently.
 *
 * NOT in edit history, for the same reason as dialogs: which surface is on
 * screen is not a document edit.
 */
export const usePaletteStore = defineStore('palette', () => {
  const open = ref(false)

  return {
    open: computed(() => open.value),
    toggle(): void { open.value = !open.value },
    show(): void { open.value = true },
    close(): void { open.value = false },
  }
})
