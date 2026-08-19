import { onMounted, onBeforeUnmount, type Ref } from 'vue'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Visible focusable descendants, in DOM order.
 *
 * NOT `offsetParent !== null`, the usual shorthand: `offsetParent` is null
 * for any `position: fixed` element, and every modal surface in this app is
 * fixed. That check would have filtered out the entire dialog and trapped
 * focus on nothing -- in the browser as well as in jsdom, which has no
 * layout at all and is what surfaced it.
 */
function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (el.hidden || el.closest('[hidden]')) return false
    const style = getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden'
  })
}

/**
 * Keep keyboard focus inside a modal surface while it is open, and give it
 * back when it closes.
 *
 * Three things a modal owes a keyboard user, none of which the signature,
 * split, or crop surfaces did before:
 *
 *  - focus moves INTO it on open, so the next Tab is inside it rather than
 *    somewhere behind it;
 *  - Tab and Shift+Tab wrap at the ends instead of escaping to the page
 *    underneath, which is unreachable and often visually obscured;
 *  - focus RETURNS to whatever opened it on close, so the user is not
 *    dropped back at the top of the document.
 *
 * Escape is routed through `onEscape` rather than handled here, because
 * what closing means differs per surface -- cancelling a crop is not the
 * same as dismissing a dialog.
 */
export function useFocusTrap(
  container: Ref<HTMLElement | null>,
  options: { onEscape?: () => void } = {},
): void {
  let previouslyFocused: HTMLElement | null = null

  function onKeydown(e: KeyboardEvent): void {
    const root = container.value
    if (!root) return

    if (e.key === 'Escape') {
      e.stopPropagation()
      options.onEscape?.()
      return
    }
    if (e.key !== 'Tab') return

    const items = focusable(root)
    if (items.length === 0) {
      // Nothing to focus: keep Tab from leaving the surface entirely.
      e.preventDefault()
      return
    }

    const first = items[0]!
    const last = items[items.length - 1]!
    const active = document.activeElement as HTMLElement | null

    if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (active === last || !root.contains(active))) {
      e.preventDefault()
      first.focus()
    }
  }

  onMounted(() => {
    previouslyFocused = document.activeElement as HTMLElement | null
    const root = container.value
    if (root) (focusable(root)[0] ?? root).focus()
    document.addEventListener('keydown', onKeydown, true)
  })

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKeydown, true)
    // Returning focus is the half that is usually forgotten; without it the
    // user lands back at the top of the document with no idea where they were.
    previouslyFocused?.focus?.()
  })
}
