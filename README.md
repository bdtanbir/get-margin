# Get Margin

## Requirements

- Node.js `>=22`
- pnpm `9.15.0`

This repo is a pnpm workspace. Install dependencies from the repository root:

```bash
pnpm install
```

## Development

Run the web app development server:

```bash
pnpm --filter @margin/web dev
```

You can also run the same command from the app directory:

```bash
cd apps/web
pnpm dev
```

Vite will print the local URL in the terminal, usually `http://localhost:5173/`.

## Available Commands

Run these from the repository root unless noted otherwise.

### Root workspace

```bash
pnpm test
pnpm test:watch
pnpm test:golden:update
pnpm typecheck
```

### Web app

```bash
pnpm --filter @margin/web dev
pnpm --filter @margin/web build
pnpm --filter @margin/web preview
pnpm --filter @margin/web typecheck
pnpm --filter @margin/web e2e
pnpm --filter @margin/web fonts:fetch
pnpm --filter @margin/web icons:make
```

### PDF core package

```bash
pnpm --filter @margin/pdf-core fixtures
```

## Progressive Web App

The web app installs. `vite-plugin-pwa` generates a manifest and a service
worker at build time, so the editor can be added to a dock, launcher or home
screen and opened in its own window with no browser chrome.

**Offline.** The service worker precaches the shell — HTML, JS and CSS, about
820 KB. It deliberately does *not* precache MuPDF's 10 MB WASM binary or the
1.6 MB of bundled fonts; those are cached at runtime, on first use. The
practical consequence is that the app works offline **from the second visit
onwards**: on a first visit the WASM request is already in flight before the
service worker has activated, so it does not pass through the cache.
`apps/web/e2e/pwa.spec.ts` asserts this contract, including that the wasm and
fonts stay out of the precache.

**Updates are offered, never applied.** A new build installs and waits; the
user is asked before the page reloads onto it. Reloading silently would
discard an open document and its unexported edits. See
`apps/web/src/lib/pwa/updates.ts`.

**Opening PDFs from the OS.** The manifest declares a `file_handlers` entry
for `application/pdf`, so an installed copy appears in "Open with". The
handoff arrives on `window.launchQueue` and is consumed in
`apps/web/src/lib/pwa/launchQueue.ts`. Chromium desktop only; other browsers
ignore the field and the drop zone is unaffected.

**Privacy is unchanged.** A service worker caches this app's own static
assets. It never sees a user's PDF: documents are opened from disk into
memory and never fetched over the network, so there is nothing for a cache to
hold.

**No service worker in `vite dev`.** A cache in front of the dev server
serves yesterday's module to today's edit. Verify PWA behaviour against a
real build:

```bash
pnpm --filter @margin/web build
pnpm --filter @margin/web preview
```

**Icons.** `public/icons/` is generated and committed. Edit the mark in
`apps/web/scripts/make-icons.mjs` and re-run `pnpm --filter @margin/web
icons:make` to regenerate every size plus `public/favicon.svg`.

## Common Test Flow

```bash
pnpm typecheck
pnpm test
pnpm --filter @margin/web build
```
