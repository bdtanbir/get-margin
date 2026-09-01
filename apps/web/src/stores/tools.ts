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
  | 'editImage'
  | 'lift'

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
  /**
   * The text patch being dragged right now, if any.
   *
   * Set for the duration of one gesture and cleared when the pointer comes
   * up, so the alignment rails appear only while a line is actually in
   * flight -- a page permanently overlaid with dashed guides is a page
   * nobody can read.
   *
   * It lives here rather than inside `SelectionChrome` because the chrome
   * owns the drag and `PageOverlay` owns the SVG the rails have to be drawn
   * in, and they are siblings. Transient like everything else in this
   * store: which object is mid-drag is not an undoable step.
   */
  const movingPatchId = ref<string | undefined>(undefined)

  /**
   * A request from elsewhere in the app to open one of the two
   * document-editing tools ON A PARTICULAR THING.
   *
   * It exists because a double-click on the page decides WHAT was hit --
   * `PageOverlay` owns the coordinates and the extraction -- while only
   * `PatchEditor` and `ImageEditor` know how to open it, and neither is
   * mounted until its tool is active. So the answer is parked here for the
   * tool that is about to mount, addressed by page: every page mounts its
   * own copy of both tools, and an unaddressed request would open an editor
   * on all of them at once.
   *
   * Transient like everything else in this store. Which line the user is
   * about to edit is not an undoable step, and the request is consumed the
   * moment it is honoured -- a request left lying around would fire again
   * on the next page to scroll into view.
   */
  const pendingPatch = ref<{ pageId: string; lineIndex: number } | undefined>(undefined)
  const pendingImage = ref<{ pageId: string; imageIndex: number } | undefined>(undefined)

  function setTool(id: ToolId): void {
    if (id === active.value) return
    active.value = id
    draft.value = undefined
    editingId.value = undefined
    // A request belongs to the tool it was made for. Picking a tool by hand
    // abandons it -- otherwise a request that never found its page would sit
    // here and fire the next time that tool happened to be opened.
    pendingPatch.value = undefined
    pendingImage.value = undefined
    // A selection belongs to the select tool. Leaving it visible while a
    // drawing tool is active makes the handles look interactive when they
    // are not.
    if (id !== 'select') useEditsStore().clearSelection()
  }

  function setDraft(d: Draft): void { draft.value = d }
  function clearDraft(): void { draft.value = undefined }

  function startEditing(id: string): void { editingId.value = id }
  function stopEditing(): void { editingId.value = undefined }

  /**
   * Open the Edit text tool on one line of the document's own text.
   *
   * The tool is set FIRST: `setTool` clears any request, so recording this
   * one before switching would throw it away.
   */
  function requestPatch(pageId: string, lineIndex: number): void {
    setTool('patch')
    pendingPatch.value = { pageId, lineIndex }
  }

  /** Open the Edit image tool on one of the images the document draws. */
  function requestImage(pageId: string, imageIndex: number): void {
    setTool('editImage')
    pendingImage.value = { pageId, imageIndex }
  }

  function startMovingPatch(id: string): void { movingPatchId.value = id }
  function stopMovingPatch(): void { movingPatchId.value = undefined }

  return {
    active: computed(() => active.value),
    fieldType: computed(() => fieldType.value),
    setFieldType(type: FieldType): void { fieldType.value = type },
    draft: computed(() => draft.value),
    editingId: computed(() => editingId.value),
    movingPatchId: computed(() => movingPatchId.value),
    pendingPatch: computed(() => pendingPatch.value),
    pendingImage: computed(() => pendingImage.value),
    setTool,
    requestPatch,
    requestImage,
    clearPendingPatch(): void { pendingPatch.value = undefined },
    clearPendingImage(): void { pendingImage.value = undefined },
    setDraft,
    clearDraft,
    startEditing,
    stopEditing,
    startMovingPatch,
    stopMovingPatch,
  }
})
