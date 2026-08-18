import { useMagicKeys, whenever } from '@vueuse/core'
import { useViewportStore } from '@/stores/viewport'

/**
 * Viewport shortcuts. Phase 2 adds tool shortcuts; this is deliberately only
 * the read-only set so there is nothing to re-map later.
 *
 * Only ever installed from `DesktopShell.vue`'s setup block, which itself
 * only mounts once `doc.status === 'ready'` (see App.vue). That is the
 * entire scoping mechanism — there is no separate "is this the right
 * moment" check here, and none is needed: a document must be open and
 * displayed on desktop chrome before this composable is even called, and
 * vueuse's `useEventListener` (which `useMagicKeys` uses internally) tears
 * its `window` listeners down automatically when the calling component's
 * effect scope is disposed, i.e. the moment DesktopShell unmounts (a
 * shell swap, a reset back to DropZone). Nothing here can fire once the
 * document isn't open and on desktop.
 *
 * Key names use `equal`/`minus`/`digit0` — KeyboardEvent.code (the
 * physical key), not `=`/`-`/`0` (KeyboardEvent.key, the character
 * produced). This matters: holding Shift while pressing the same physical
 * key as "=" produces the character "+", not "=" — a real, common way to
 * press "zoom in" (Cmd+Shift+= is what "Cmd/Ctrl-Plus" actually sends on a
 * standard keyboard, since there is no separate "+" key). A combo keyed on
 * `.key` would silently never fire for that keystroke. `.code` is
 * immune to Shift entirely, so one binding covers both "Cmd+=" and
 * "Cmd+Shift+=" (visually "Cmd+Plus").
 */
export function useViewportShortcuts(): void {
  const vp = useViewportStore()
  const keys = useMagicKeys({
    passive: false,
    onEventFired(e) {
      // The browser's own zoom would fight ours, so claim these combos —
      // both the unshifted and shifted (Cmd/Ctrl-Plus) forms of the key.
      if ((e.metaKey || e.ctrlKey) && ['=', '+', '-', '0'].includes(e.key)) e.preventDefault()
    },
  })

  // Non-null assertions: `noUncheckedIndexedAccess` (tsconfig.base.json)
  // types every bracket access on useMagicKeys' Record<string, ...> return
  // as possibly `undefined`, but the proxy `useMagicKeys` returns always
  // synthesizes a real ComputedRef for any string key requested (see the
  // library source: unregistered keys fall through to a `computed(...)`
  // constructed on first access) — it is a Proxy, not a plain object with
  // genuinely missing keys, so this is never actually undefined at runtime.
  whenever(keys['Meta+equal']!, () => vp.zoomIn())
  whenever(keys['Ctrl+equal']!, () => vp.zoomIn())
  whenever(keys['Meta+minus']!, () => vp.zoomOut())
  whenever(keys['Ctrl+minus']!, () => vp.zoomOut())
  whenever(keys['Meta+digit0']!, () => { vp.setFitMode('actual'); vp.setZoom(1) })
  whenever(keys['Ctrl+digit0']!, () => { vp.setFitMode('actual'); vp.setZoom(1) })

  // Fit-width. NOTE (found during implementation, not part of the original
  // brief): Ctrl+1 / Cmd+1 double as "switch to the first tab" in every
  // major desktop browser (Chrome, Firefox, Safari), and that shortcut is
  // reserved by the browser chrome itself — real keystrokes are consumed
  // before a keydown event ever reaches page JS, `preventDefault()` or not.
  // A user pressing Cmd+1 here will switch browser tabs, not fit the page
  // to width; this binding is effectively unreachable in normal use. Kept
  // as specified rather than unilaterally rebound, since choosing a
  // replacement combo is a product decision outside this task's scope —
  // flagged here and in the Task 21 report for a follow-up decision.
  whenever(keys['Meta+digit1']!, () => vp.setFitMode('width'))
  whenever(keys['Ctrl+digit1']!, () => vp.setFitMode('width'))
}
