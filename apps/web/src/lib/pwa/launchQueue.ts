/**
 * The File Handling API: how an installed PWA gets opened BY the operating
 * system, from "Open with" in a file manager or from a double-clicked PDF.
 *
 * The browser does not pass the file through the URL. It hands the page a
 * `FileSystemFileHandle` on `window.launchQueue`, once, at startup. Nothing
 * here is typed by TypeScript's DOM library, so the three shapes this app
 * touches are declared below rather than reached for through `any`.
 *
 * Chromium desktop only, today. Safari and Firefox ignore `file_handlers`
 * in the manifest entirely -- which costs those users this entry point and
 * nothing else, since the drop zone and the file picker are unaffected.
 */

export type LaunchParams = { files?: readonly FileSystemFileHandle[] }
export type LaunchConsumer = (params: LaunchParams) => Promise<void>
export type LaunchQueue = { setConsumer: (consumer: LaunchConsumer) => void }

/** `window.launchQueue`, or undefined on a browser that has no such thing. */
export function browserLaunchQueue(): LaunchQueue | undefined {
  return (globalThis as { launchQueue?: LaunchQueue }).launchQueue
}

/**
 * Open the file the OS launched us with, if it launched us with one.
 *
 * MUST be called during startup, synchronously enough that the consumer is
 * registered before the browser gives up on delivering the launch. That is
 * why it lives in main.ts rather than in a component's `onMounted`.
 */
export function consumeLaunchedFile(
  open: (file: File) => void,
  queue: LaunchQueue | undefined = browserLaunchQueue(),
  onError: (error: Error) => void = () => {},
): void {
  if (!queue) return

  queue.setConsumer(async ({ files }) => {
    // An empty launch is the ordinary case: the user clicked the app icon.
    const handle = files?.[0]
    if (!handle) return

    try {
      // Only the first. The editor holds ONE document, and the merge flow
      // (AddSourceButton) is where a second file belongs -- silently
      // merging whatever the file manager had selected would produce a
      // document the user never asked for.
      open(await handle.getFile())
    } catch (e) {
      // A handle whose permission was revoked between the launch and this
      // read. Throwing here would reject inside the browser's launch
      // dispatch, where nothing is listening.
      onError(e instanceof Error ? e : new Error(String(e)))
    }
  })
}
