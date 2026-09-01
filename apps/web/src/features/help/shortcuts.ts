/**
 * Every keyboard shortcut, once.
 *
 * The key combinations and the strings shown to the user live in the same
 * record, because the alternative is a help page that documents `⌘K` next
 * to code that binds `Ctrl+J`, and nothing in a test suite notices. The
 * bindings in `useEditShortcuts.ts` and `CommandPalette.vue` read their
 * combos from here, and a test asserts the set actually bound matches this
 * list -- so a shortcut added to one and not the other fails rather than
 * drifts.
 *
 * `combos` are useMagicKeys names. Both the Meta and Ctrl forms are listed
 * for every shortcut: a Mac user pressing Ctrl and a Windows user pressing
 * Meta should each get what they expect rather than nothing.
 */
export type ShortcutId =
  | 'undo'
  | 'redo'
  | 'find'
  | 'palette'
  | 'delete'
  | 'nudge'
  | 'nudge-far'
  | 'escape'
  | 'zoom-in'
  | 'zoom-out'

export type Shortcut = {
  id: ShortcutId
  /** What it does, in the user's words. */
  label: string
  group: 'Editing' | 'Navigating' | 'Selection'
  /** Shown on screen. Mac glyphs, matching the tooltips already in the app. */
  display: string
  /** useMagicKeys combinations. Empty when the key is handled outside useMagicKeys. */
  combos: string[]
}

export const SHORTCUTS: readonly Shortcut[] = [
  {
    id: 'undo',
    label: 'Undo',
    group: 'Editing',
    display: '⌘Z',
    combos: ['Meta+z', 'Ctrl+z'],
  },
  {
    id: 'redo',
    label: 'Redo',
    group: 'Editing',
    display: '⇧⌘Z',
    // Ctrl+Y is the Windows convention and costs nothing to accept.
    combos: ['Meta+Shift+z', 'Ctrl+Shift+z', 'Ctrl+y'],
  },
  {
    id: 'delete',
    label: 'Delete what is selected',
    group: 'Editing',
    display: 'Delete',
    combos: ['Delete', 'Backspace'],
  },
  {
    id: 'nudge',
    label: 'Move what is selected',
    group: 'Editing',
    display: '↑ ↓ ← →',
    // Bound AFTER the shifted forms below, for the reason undo's comment
    // gives: useMagicKeys reports `ArrowUp` as true during `Shift+ArrowUp`
    // as well, so the plain binding has to check that Shift is not down.
    combos: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
  },
  {
    id: 'nudge-far',
    label: 'Move it ten times as far',
    group: 'Editing',
    display: '⇧ and an arrow',
    combos: ['Shift+ArrowUp', 'Shift+ArrowDown', 'Shift+ArrowLeft', 'Shift+ArrowRight'],
  },
  {
    id: 'find',
    label: 'Find in document',
    group: 'Navigating',
    display: '⌘F',
    combos: ['Meta+f', 'Ctrl+f'],
  },
  {
    id: 'palette',
    label: 'Open the command palette',
    group: 'Navigating',
    display: '⌘K',
    combos: ['Ctrl+k'],
  },
  {
    id: 'zoom-in',
    label: 'Zoom in',
    group: 'Navigating',
    display: '⌘+',
    // Handled by the zoom controls rather than useMagicKeys; listed here
    // because the help page's job is to describe the product, not the
    // implementation. `combos` being empty is what keeps the binding test
    // honest about that.
    combos: [],
  },
  {
    id: 'zoom-out',
    label: 'Zoom out',
    group: 'Navigating',
    display: '⌘−',
    combos: [],
  },
  {
    id: 'escape',
    label: 'Clear the selection, or close what is open',
    group: 'Selection',
    display: 'Esc',
    combos: ['Escape'],
  },
]

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]))

export function shortcut(id: ShortcutId): Shortcut {
  const found = BY_ID.get(id)
  // Unreachable through the type, and a loud failure if the list is edited
  // carelessly -- better than silently binding nothing.
  if (!found) throw new Error(`no shortcut declared for "${id}"`)
  return found
}

/** The combos for one shortcut, in declaration order -- which matters for undo/redo. */
export function combosFor(id: ShortcutId): string[] {
  return shortcut(id).combos
}

/** Grouped for display, preserving the order above within each group. */
export function shortcutsByGroup(): Array<[Shortcut['group'], Shortcut[]]> {
  const groups = new Map<Shortcut['group'], Shortcut[]>()
  for (const s of SHORTCUTS) {
    const list = groups.get(s.group) ?? []
    list.push(s)
    groups.set(s.group, list)
  }
  return [...groups]
}
