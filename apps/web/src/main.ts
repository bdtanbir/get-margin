import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { registerSW } from 'virtual:pwa-register'
import App from './app/App.vue'
import { initTelemetry } from './lib/telemetry/analytics'
import { reporter } from './lib/telemetry/reporter'
import { installPwaUpdates } from './lib/pwa/updates'
import { consumeLaunchedFile } from './lib/pwa/launchQueue'
import { useDocumentStore } from './stores/document'
import './app/styles/tokens.css'

const app = createApp(App)

/**
 * Last resort, for anything no ErrorBoundary caught — an error in a
 * lifecycle hook outside a boundary, or in a boundary's own fallback.
 *
 * Re-thrown in development so the failure still reaches the console and
 * Vite's overlay; in production it is recorded and swallowed, because an
 * unhandled error here unmounts the app and takes the user's session with
 * it. Swallowing SILENTLY would be worse than either, so it is logged
 * with the Vue lifecycle hook that produced it.
 */
app.config.errorHandler = (err, _instance, info) => {
  const error = err instanceof Error ? err : new Error(String(err))
  // eslint-disable-next-line no-console
  console.error(`[get-margin] unhandled error (${info})`, error)
  reporter().reportError({ name: 'unhandled', component: 'App', error })
  if (import.meta.env.DEV) throw error
}

/**
 * Point the reporter somewhere, or -- in the default build -- at nothing.
 *
 * Called before mount so the very first error has somewhere to go. With no
 * `VITE_TELEMETRY_ENDPOINT` configured this constructs no transport at
 * all, so the absence of network traffic is structural rather than a flag
 * someone could flip by accident.
 */
initTelemetry()

/**
 * Register the service worker, and remember the handle it returns.
 *
 * Called before mount so a worker that is ALREADY waiting -- the case where
 * the user last closed the app mid-deploy -- is reported to the prompt on
 * the first frame rather than after one.
 */
installPwaUpdates(registerSW)

app.use(createPinia()).mount('#app')

/**
 * Take the file the OS launched us with, if any.
 *
 * After mount, because it opens a document through the store and Pinia has
 * to be installed first. Still synchronous with startup, which is what the
 * launch queue requires -- a consumer registered a tick too late gets
 * nothing, and the user sees an empty editor after double-clicking a PDF.
 */
const doc = useDocumentStore()
consumeLaunchedFile(
  (file) => void doc.openFile(file),
  undefined,
  (error) => {
    doc.error = 'That file could not be opened from your file manager. Try opening it here instead.'
    reporter().reportError({ name: 'launch-queue', component: 'main', error })
  },
)
