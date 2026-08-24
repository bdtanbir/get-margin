import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath } from 'node:url'

/**
 * Brand colours for the manifest, as hex.
 *
 * The tokens in `src/app/styles/tokens.css` are authored in oklch, which
 * the manifest spec does not guarantee a consumer understands -- an Android
 * launcher that cannot parse the splash colour falls back to white, which
 * is exactly the flash `background_color` exists to prevent. These are the
 * sRGB values of `--color-accent` (light) and `--color-canvas` (light).
 */
const THEME_COLOR = '#3c5cdd'
const BACKGROUND_COLOR = '#f4f4f6'

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    VitePWA({
      /**
       * `prompt`, not `autoUpdate`. An automatic reload would swap the code
       * under a page holding an open document, unsaved edits and a MuPDF
       * instance in a worker. See `src/lib/pwa/updates.ts`.
       */
      registerType: 'prompt',
      /**
       * The registration is written by hand in `src/main.ts` rather than
       * injected into index.html, so it goes through the same bundle, the
       * same error handling and the same tests as everything else.
       */
      injectRegister: false,
      /** Not matched by `globPatterns` below, but still needed offline. */
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon-180.png'],
      manifest: {
        name: 'get-margin — PDF editor',
        short_name: 'get-margin',
        description:
          'Read, annotate, reorder and export PDFs. Files are processed in your browser and never uploaded.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        theme_color: THEME_COLOR,
        background_color: BACKGROUND_COLOR,
        categories: ['productivity', 'utilities'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          /**
           * Android crops icons to a device-chosen shape and only the
           * middle 80% is guaranteed to survive. Without this entry it
           * crops the square one and takes the corners off the mark.
           */
          {
            src: 'icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        /**
         * What makes the OS offer this app in "Open with" for a PDF.
         * Chromium desktop only today; other browsers ignore the field.
         * The handoff is consumed in `src/lib/pwa/launchQueue.ts`.
         */
        file_handlers: [
          {
            action: '/',
            accept: { 'application/pdf': ['.pdf'] },
          },
        ],
        /**
         * Reuse the window that is already open rather than starting a
         * second copy: two tabs of this editor on the same file would keep
         * two independent edit histories and two autosave writers racing
         * for the same IndexedDB record.
         */
        launch_handler: { client_mode: 'navigate-existing' },
      },
      workbox: {
        /**
         * THE SHELL ONLY -- about 800 KB gzipped of JS, CSS and HTML.
         *
         * The precache is downloaded in full before the app works offline,
         * so its contents are a budget rather than a preference. MuPDF's
         * wasm is 10 MB and the bundled fonts are another 1.6 MB; putting
         * either here would turn every first visit into a multi-megabyte
         * download for capability the visitor has not asked for yet. Both
         * are cached at runtime instead, on first use, when the user is
         * already paying that cost. `e2e/pwa.spec.ts` holds this line.
         */
        globPatterns: ['**/*.{js,css,html}'],
        /**
         * Take control of the page that just registered us, instead of
         * waiting for the next navigation.
         *
         * Safe precisely because `skipWaiting` stays false: this claims
         * clients that no service worker was controlling, which only ever
         * happens on a FIRST visit -- there is no older version to swap
         * out from under anyone. Without it the app is not actually
         * available offline until the user happens to reload once, and
         * "install it, then close your laptop, then find it doesn't open"
         * is the failure this whole feature exists to prevent.
         */
        clientsClaim: true,
        /**
         * Offline navigation for a single-page app: any URL the user
         * reloads must resolve to the cached shell, because there is no
         * server to route it when the network is gone.
         */
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            // MuPDF. Immutable and content-hashed, so once it is cached
            // there is never a reason to revalidate it over the network.
            urlPattern: ({ url }) => url.pathname.endsWith('.wasm'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'margin-wasm',
              // Two, not one: a build deployed while a tab is open leaves
              // the old hash in use until that tab reloads.
              expiration: { maxEntries: 2 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // The bundled TrueType faces, fetched by `lib/fonts.ts` only
            // when a document actually uses one.
            urlPattern: ({ url }) => url.pathname.startsWith('/fonts/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'margin-fonts',
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      /**
       * No service worker in `vite dev`. A cache sitting in front of the
       * dev server serves yesterday's module to today's edit, and the time
       * lost to that is never spent debugging the thing you were debugging.
       * Verify the PWA against `pnpm build && pnpm preview`, which is what
       * `e2e/pwa.spec.ts` does.
       */
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  worker: { format: 'es' },
  optimizeDeps: {
    // The WASM package must not be pre-bundled — esbuild mangles its loader.
    exclude: ['mupdf'],
  },
  build: { target: 'es2022' },
})
