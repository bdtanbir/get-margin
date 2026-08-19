import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Rect } from '@margin/transform'
import { useEditsStore } from '@/stores/edits'

export type ToolId =
  | 'select' | 'text' | 'image' | 'rect' | 'ellipse' | 'line' | 'arrow'
  | 'ink' | 'whiteout' | 'link' | 'signature'
  | 'highlight' | 'underline' | 'strikeout'

/** An object being dragged out but not yet committed. */
export type Draft = { pageId: string; rect: Rect }

/**
 * Transient tool state. NOTHING here enters edit history -- a half-drawn
 * rectangle is not an undoable step. The moment a draft becomes real it goes
 * through edits.applyOp and this store forgets it.
 */
export const useToolsStore = defineStore('tools', () => {
  const active = ref<ToolId>('select')
  const draft = ref<Draft | undefined>(undefined)

  function setTool(id: ToolId): void {
    if (id === active.value) return
    active.value = id
    draft.value = undefined
    // A selection belongs to the select tool. Leaving it visible while a
    // drawing tool is active makes the handles look interactive when they
    // are not.
    if (id !== 'select') useEditsStore().clearSelection()
  }

  function setDraft(d: Draft): void { draft.value = d }
  function clearDraft(): void { draft.value = undefined }

  return {
    active: computed(() => active.value),
    draft: computed(() => draft.value),
    setTool,
    setDraft,
    clearDraft,
  }
})
