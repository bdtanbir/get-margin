import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './app/App.vue'
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
  if (import.meta.env.DEV) throw error
}

app.use(createPinia()).mount('#app')
