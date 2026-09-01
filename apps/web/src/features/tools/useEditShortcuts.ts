import { useMagicKeys, whenever } from '@vueuse/core'
import { combosFor } from '@/features/help/shortcuts'
import { useEditsStore } from '@/stores/edits'
import { deleteOpFor } from '@/features/patch/patchDelete'
import { useToolsStore } from '@/stores/tools'
import { useSelectionStore } from '@/stores/selection'
import { useDialogsStore } from '@/stores/dialogs'
import { useDocumentStore } from '@/stores/document'
import { useViewportStore } from '@/stores/viewport'
import { nudgeOpFor } from '@/features/overlay/nudge'

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
/**
 * How far one arrow press moves what is selected, in POINTS.
 *
 * Document units rather than screen pixels, so a nudge is the same distance
 * at 400% as it is at 100%. A step that shrank as you zoomed in would be
 * backwards: the keyboard is what you reach for when the mouse is not
 * precise enough, and zooming in is the other half of that same gesture.
 */
const NUDGE_PT = 1
const NUDGE_FAR_PT = 10

/** Which way each arrow points, in SCREEN terms: y grows downwards. */
const DIRECTIONS: Record<string, { dx: number; dy: number }> = {
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
}

/** The arrow in a combo, so the key names stay declared in one place. */
function directionFor(combo: string): { dx: number; dy: number } | undefined {
  return DIRECTIONS[combo.split('+').pop() ?? '']
}

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true
  if ((el as HTMLElement).isContentEditable) return true
  return Boolean(el.closest?.('[contenteditable]:not([contenteditable="false"])'))
}

export function useEditShortcuts(): string[] {
  const edits = useEditsStore()
  const tools = useToolsStore()
  const dialogs = useDialogsStore()
  const selection = useSelectionStore()
  const doc = useDocumentStore()
  const vp = useViewportStore()

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
      // And the arrows, but ONLY when they are about to move something:
      // with nothing selected they belong to the browser, which is what
      // someone pressing them means by it.
      //
      // Defensive rather than a fix for an observed scroll. A browser
      // scrolls the nearest scrollable ancestor of whatever has focus, and
      // nothing in the shell today puts focus inside the page scroller --
      // all three engines leave the document still without this. Giving
      // the scroller a tabindex, which any accessibility pass might
      // reasonably do, is all it would take; and claiming a key you are
      // handling is the ordinary thing to do anyway. It has to happen here
      // rather than in the handler, because by the time a `whenever`
      // watcher runs the page would already have moved.
      if (
        !isTypingTarget(e.target as Element | null) &&
        !dialogs.open &&
        edits.selection.length > 0 &&
        Object.hasOwn(DIRECTIONS, e.key)
      ) {
        e.preventDefault()
      }
    },
  })

  const typingSomewhere = (): boolean => isTypingTarget(document.activeElement)

  const guard = (fn: () => void) => () => { if (!typingSomewhere()) fn() }

  /**
   * Every combination bound here, collected as it is registered.
   *
   * Returned so a test can compare it against the declared shortcut list
   * and catch the case this whole indirection exists to prevent: a
   * shortcut documented on the help page that nothing actually binds.
   */
  const bound: string[] = []
  const bind = (combo: string, handler: () => void): void => {
    bound.push(combo)
    whenever(keys[combo]!, handler)
  }

  // Combinations come from the shortcut list rather than string literals,
  // so the help page and the binding cannot describe different keys.
  for (const combo of combosFor('redo')) bind(combo, guard(() => edits.redo()))

  // Registered AFTER the shifted forms: useMagicKeys reports `Meta+z` as
  // true during `Meta+Shift+z` too, so an unguarded plain-undo binding
  // would fire alongside redo and cancel it out. The list's declaration
  // order is what preserves this -- redo is declared before undo's combos
  // are read.
  for (const combo of combosFor('undo')) {
    bind(combo, guard(() => { if (!keys.shift!.value) edits.undo() }))
  }

  /**
   * Find. NOT guarded by `typingSomewhere`, unlike the others: Cmd+F is the
   * one shortcut people expect to work while their cursor is in a text
   * box, and the browser's own find would open otherwise.
   */
  const openFind = (): void => {
    dialogs.show('find')
  }
  for (const combo of combosFor('find')) bind(combo, openFind)

  for (const combo of combosFor('delete')) bind(combo, guard(deleteSelection))

  // Shifted forms FIRST, then the plain ones guarded against Shift -- the
  // same ordering undo and redo need, and for the same reason: useMagicKeys
  // reports `ArrowRight` as down during `Shift+ArrowRight`, so a plain
  // binding registered without that guard fires alongside the shifted one
  // and the object travels eleven points instead of ten.
  for (const combo of combosFor('nudge-far')) {
    const dir = directionFor(combo)
    if (dir) bind(combo, guard(() => nudge(dir, NUDGE_FAR_PT)))
  }
  for (const combo of combosFor('nudge')) {
    const dir = directionFor(combo)
    if (dir) bind(combo, guard(() => { if (!keys.shift!.value) nudge(dir, NUDGE_PT) }))
  }

  for (const combo of combosFor('escape')) bind(combo, () => {
    // A dialog owns Escape while it is open -- each traps focus and
    // handles its own -- so this only reaches the canvas.
    if (dialogs.open) return
    selection.clear()
    edits.clearSelection()
    tools.setTool('select')
  })

  // What was actually bound, for the drift check in the help suite.
  return bound

  /**
   * Move what is selected by one step in a direction.
   *
   * The keyboard half of the drag in `SelectionChrome`, and it goes through
   * `nudgeOpFor` so the two cannot disagree about which geometry each kind
   * of object moves -- a patch shifts its offset and leaves the cover it
   * paints behind, everything else moves its rect.
   *
   * Coalesced per object, like typing into a form field: a run of presses
   * is one thing the user did, and undoing it should not take twenty
   * presses of its own. Any other edit in between ends the run, because
   * only the entry on top of the history can absorb the next one.
   */
  function nudge(dir: { dx: number; dy: number }, step: number): void {
    // The pages grid inside the dialog binds its own arrows. Nudging the
    // canvas underneath at the same time would move something the user
    // cannot currently see.
    if (dialogs.open) return
    const id = edits.selection[0]
    const object = id ? edits.doc.objects[id] : undefined
    if (!id || !object) return
    // A page whose source is not loaded has no geometry to convert
    // through, and inventing one would put the object somewhere arbitrary.
    const geometry = doc.geometryOf(object.pageId)
    if (!geometry) return
    const op = nudgeOpFor(object, { dx: dir.dx * step, dy: dir.dy * step }, geometry, vp.zoom)
    if (op) edits.applyOp(op, 'Move', `nudge:${id}`)
  }

  function deleteSelection(): void {
    const id = edits.selection[0]
    if (!id) return
    const object = edits.doc.objects[id]
    // A locked object is locked against deletion too -- unlock is a
    // deliberate act, and Backspace is not.
    if (!object || object.locked) return
    // The same rule the toolbar's trash follows: a patch carrying a copy
    // loses the copy first, so the thing on screen actually goes. See
    // `deleteOpFor`.
    const op = deleteOpFor(object)
    edits.applyOp(op, 'Delete')
    if (op.type === 'deleteObject') edits.clearSelection()
  }
}
