import { useMagicKeys, whenever } from '@vueuse/core'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { useSelectionStore } from '@/stores/selection'
import { useDialogsStore } from '@/stores/dialogs'

/**
 * Undo / redo / delete-selection, plus Escape to return to the select tool.
 *
 * Phase 2 built a full history stack and, until this, left it unreachable:
 * nothing in the UI called `undo()`. Keyboard is the primary path on
 * desktop; TopBar carries buttons for the same actions so the feature is
 * not keyboard-only.
 *
 * Installed only from DesktopShell (which itself mounts only once a
 * document is open), so the same scoping argument as useViewportShortcuts
 * applies: vueuse tears the window listeners down with the calling
 * component's effect scope, and nothing here can fire without a document.
 */
/**
 * True when `el` sits inside something the user types into.
 *
 * Checks `closest('[contenteditable]')` as well as `isContentEditable`:
 * the property covers inherited editability in real browsers but jsdom does
 * not implement it at all, so the attribute walk is what makes this
 * testable — and it independently covers an editable ancestor.
 */
function isTypingTarget(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true
  if ((el as HTMLElement).isContentEditable) return true
  return Boolean(el.closest?.('[contenteditable]:not([contenteditable="false"])'))
}

export function useEditShortcuts(): void {
  const edits = useEditsStore()
  const tools = useToolsStore()
  const dialogs = useDialogsStore()
  const selection = useSelectionStore()

  const keys = useMagicKeys({
    passive: false,
    onEventFired(e) {
      // Claim undo/redo before the browser applies them to whatever native
      // control happens to have focus. NOT claimed while a contenteditable
      // or input has focus: there, the browser's own text-level undo is the
      // behaviour the user expects, and TextEditor already coalesces its
      // typing into single history entries of its own.
      if (
        !isTypingTarget(e.target as Element | null) &&
        (e.metaKey || e.ctrlKey) &&
        (e.key === 'z' || e.key === 'y')
      ) {
        e.preventDefault()
      }
    },
  })

  const typingSomewhere = (): boolean => isTypingTarget(document.activeElement)

  const guard = (fn: () => void) => () => { if (!typingSomewhere()) fn() }

  whenever(keys['Meta+Shift+z']!, guard(() => edits.redo()))
  whenever(keys['Ctrl+Shift+z']!, guard(() => edits.redo()))
  // Ctrl+Y is the Windows convention for redo and costs nothing to accept.
  whenever(keys['Ctrl+y']!, guard(() => edits.redo()))

  // Registered AFTER the shifted forms: useMagicKeys reports `Meta+z` as
  // true during `Meta+Shift+z` too, so an unguarded plain-undo binding
  // would fire alongside redo and cancel it out.
  whenever(keys['Meta+z']!, guard(() => { if (!keys.shift!.value) edits.undo() }))
  whenever(keys['Ctrl+z']!, guard(() => { if (!keys.shift!.value) edits.undo() }))

  /**
   * Find. NOT guarded by `typingSomewhere`, unlike the others: Cmd+F is the
   * one shortcut people expect to work while their cursor is in a text
   * box, and the browser's own find would open otherwise.
   */
  const openFind = (): void => {
    dialogs.show('find')
  }
  whenever(keys['Meta+f']!, openFind)
  whenever(keys['Ctrl+f']!, openFind)

  whenever(keys['Delete']!, guard(deleteSelection))
  whenever(keys['Backspace']!, guard(deleteSelection))

  whenever(keys['Escape']!, () => {
    // A dialog owns Escape while it is open -- each traps focus and
    // handles its own -- so this only reaches the canvas.
    if (dialogs.open) return
    selection.clear()
    edits.clearSelection()
    tools.setTool('select')
  })

  function deleteSelection(): void {
    const id = edits.selection[0]
    if (!id) return
    const object = edits.doc.objects[id]
    // A locked object is locked against deletion too -- unlock is a
    // deliberate act, and Backspace is not.
    if (!object || object.locked) return
    edits.applyOp({ type: 'deleteObject', id }, 'Delete')
    edits.clearSelection()
  }
}
