import { ref, type Ref } from 'vue'

/**
 * What `updateSW(true)` does: activates the service worker that is sitting
 * in `waiting` and reloads the page onto it.
 */
export type UpdateSW = (reload?: boolean) => Promise<void>

/**
 * The shape of vite-plugin-pwa's `registerSW`, narrowed to the one hook
 * this app uses. Taken as a parameter rather than imported so the logic
 * below is testable without a service worker, a build step, or the
 * `virtual:pwa-register` module that only exists inside Vite.
 */
export type RegisterSW = (hooks: { onNeedRefresh: () => void }) => UpdateSW

export type PwaUpdates = {
  /** True while a newer build is installed and waiting to take over. */
  needsRefresh: Ref<boolean>
  /** Take the update now. Reloads the page. */
  apply: () => void
  /** Keep the current build for this session. */
  dismiss: () => void
}

/**
 * OFFERED, never automatic -- the same rule RestorePrompt follows, for a
 * sharper reason.
 *
 * A silent `skipWaiting()` swaps the code under a page that is holding an
 * open document, unsaved edits, and a MuPDF instance in a worker. Reloading
 * without asking would discard all three. So the new worker installs, waits,
 * and the user picks the moment.
 */
export function createPwaUpdates(register: RegisterSW): PwaUpdates {
  const needsRefresh = ref(false)
  let updateSW: UpdateSW | undefined

  try {
    updateSW = register({
      onNeedRefresh: () => {
        needsRefresh.value = true
      },
    })
  } catch {
    // Firefox in private browsing, and any browser with service workers
    // disabled by policy, throw here. That costs the user offline support
    // and nothing else, so it must not take the app down on startup.
  }

  return {
    needsRefresh,
    apply: () => {
      // `void`: the promise settles by navigating away, so there is nothing
      // left to await and nothing to report if it never resolves.
      void updateSW?.(true)
    },
    dismiss: () => {
      needsRefresh.value = false
    },
  }
}

/**
 * The inert default, so a component can read this before -- or without --
 * any service worker being registered at all. It reports that no update is
 * waiting, which is the truth in dev, in unit tests, and in a browser that
 * refused the registration.
 */
const inert: PwaUpdates = {
  needsRefresh: ref(false),
  apply: () => {},
  dismiss: () => {},
}

// Module-level singleton, for the same reason theme.ts has one: two
// components reading it must see the same value.
let current: PwaUpdates = inert

/** Wire the real registration in. Called once, from main.ts. */
export function installPwaUpdates(register: RegisterSW): PwaUpdates {
  current = createPwaUpdates(register)
  return current
}

export function usePwaUpdates(): PwaUpdates {
  return current
}
