import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { FieldType } from '@margin/pdf-core'
import type { Rect } from '@margin/transform'
import { useEditsStore } from '@/stores/edits'

export type ToolId =
  | 'select' | 'text' | 'image' | 'rect' | 'ellipse' | 'line' | 'arrow'
  | 'ink' | 'whiteout' | 'link' | 'signature'
  | 'highlight' | 'underline' | 'strikeout'
  // Task 48. A PAGE tool, not an object tool: it changes the page's frame
  // rather than adding anything to it.
  | 'crop'
  // Task 74. ONE tool for all six field types; the type is chosen in the
  // inspector rather than costing six more rail entries in a product where
  // forms are one phase of eight.
  | 'field'
  // Task 82. Text-selection driven, like the markup tools -- and the only
  // one of them that REMOVES what it covers.
  | 'redact'
  // Task 92. Replaces a line of the DOCUMENT's own text, unlike the text
  // tool, which adds a new one.
  | 'patch'

/** An object being dragged out but not yet committed. */
export type Draft = { pageId: string; rect: Rect }

/**
 * Transient tool state. NOTHING here enters edit history -- a half-drawn
 * rectangle is not an undoable step. The moment a draft becomes real it goes
 * through edits.applyOp and this store forgets it.
 */
export const useToolsStore = defineStore('tools', () => {
  const active = ref<ToolId>('select')
  /**
   * Which kind of field the field tool draws next. Lives here rather than
   * in edit history: it is a tool setting, not a document edit.
   */
  const fieldType = ref<FieldType>('text')
  const draft = ref<Draft | undefined>(undefined)
  /**
   * The text object whose inline editor is open, if any. Transient like
   * everything else here: which box has a caret in it is not an undoable
   * step, and it lives in the store (not in TextEditor.vue) so a re-render
   * from a zoom or scroll change does not silently close the editor.
   */
  const editingId = ref<string | undefined>(undefined)

  function setTool(id: ToolId): void {
    if (id === active.value) return
    active.value = id
    draft.value = undefined
    editingId.value = undefined
    // A selection belongs to the select tool. Leaving it visible while a
    // drawing tool is active makes the handles look interactive when they
    // are not.
    if (id !== 'select') useEditsStore().clearSelection()
  }

  function setDraft(d: Draft): void { draft.value = d }
  function clearDraft(): void { draft.value = undefined }

  function startEditing(id: string): void { editingId.value = id }
  function stopEditing(): void { editingId.value = undefined }

  return {
    active: computed(() => active.value),
    fieldType: computed(() => fieldType.value),
    setFieldType(type: FieldType): void { fieldType.value = type },
    draft: computed(() => draft.value),
    editingId: computed(() => editingId.value),
    setTool,
    setDraft,
    clearDraft,
    startEditing,
    stopEditing,
  }
})
