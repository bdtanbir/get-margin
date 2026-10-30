# Get Margin — Free Online PDF Editor That Runs in Your Browser

**[Try the live demo → pdf.tanbirahmod.com](https://pdf.tanbirahmod.com)**

Get Margin is a free, private **online PDF editor** that runs
entirely in your browser. Edit PDF text, annotate, highlight, sign, fill PDF
forms, redact, reorder pages, compress and export — with **no upload, no
sign-up and no watermark**. Your PDF is opened from disk into memory and never
leaves your device.

It works on desktop, tablet and phone, and installs as an app (PWA) that keeps
working offline.

## Features

### Edit PDF text and images
- Edit existing text in a PDF: change a line or a whole paragraph, with
  wrapping and new lines
- Font matching with bundled fonts, so edited text looks like the original
- Add new text boxes, images and links
- Whiteout to cover content

### Annotate and mark up PDFs
- Highlight, underline and strikeout text
- Freehand drawing (ink), lines, arrows, rectangles and ellipses
- Add watermarks, page numbers, headers, footers and Bates numbering

### Sign and fill PDF forms
- Add a signature to a PDF — draw, type or upload it
- Fill in PDF form fields and edit the tab order

### Organize pages
- Reorder pages by drag and drop
- Rotate, delete, crop and split pages
- Merge PDFs by adding pages from other files

### Secure and optimize
- **Redact** sensitive content — the text is removed, not just covered
- Password-protect a PDF
- Compress a PDF to reduce file size
- Edit document metadata (title, author, subject, keywords)
- Find text across the whole document

### Export
- Download the edited PDF
- Export pages as images

## Privacy: your PDF never leaves your device

Editing, annotation, redaction, signing, form filling and image export all
happen inside your browser tab, powered by [MuPDF](https://mupdf.com/)
compiled to WebAssembly. There is no account and no server-side storage of
your documents.

The one exception is file conversion. Converting a file needs a server, so
the app asks first: a consent screen names the file, its size and when it
will be deleted. Nothing is uploaded until you agree.

## Why Get Margin?

| | Get Margin |
|---|---|
| Price | Free |
| Account needed | No |
| Watermark on export | No |
| File upload for editing | No — processed in the browser |
| Works offline | Yes, after the first visit (installable PWA) |
| Devices | Desktop, tablet and mobile |

## Tech stack

- **Frontend:** Vue 3, Vite, Tailwind CSS, TypeScript
- **PDF engine:** MuPDF.js (WebAssembly) in a Web Worker
- **Offline / install:** `vite-plugin-pwa` service worker and web app manifest
- **Testing:** Vitest (including golden-file PDF rendering tests) and Playwright
- **Monorepo:** pnpm workspaces (`apps/web`, `packages/pdf-core`, and more)

## FAQ

**Is Get Margin free?**
Yes. The editor at [pdf.tanbirahmod.com](https://pdf.tanbirahmod.com) is free
to use, with no sign-up and no watermark.

**Are my PDF files uploaded to a server?**
No. Files are processed locally in your browser. Only file conversion uses a
server, and only after you agree on a consent screen.

**Can I edit the existing text in a PDF?**
Yes. Click a line or paragraph to edit it in place. The app matches the
original font where it can.

**Does it work offline?**
Yes. Install it as an app, and after the first visit it opens and edits PDFs
without an internet connection.

**Does it work on mobile?**
Yes. The layout adapts down to phone screens.

## Getting started

### Requirements

- Node.js `>=22`
- pnpm `9.15.0`

This repo is a pnpm workspace. Install dependencies from the repository root:

```bash
pnpm install
```

### Run the development server

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

## Available commands

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

## Progressive Web App (install and use offline)

The web app installs. `vite-plugin-pwa` generates a manifest and a service
worker at build time, so the editor can be added to a dock, launcher or home
screen and opened in its own window with no browser chrome.

**Offline.** The service worker precaches the shell — HTML, JS and CSS, about
820 KB. It deliberately does *not* precache MuPDF's 10 MB WASM binary or the
12 MB of bundled fonts; those are cached at runtime, on first use, one face
at a time. The
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

## Deployment headers

`apps/web/vercel.json` sets two `Cache-Control` rules. JSON takes no
comments, so the reasoning lives here.

`/assets/*` is `immutable` for a year. Vite content-hashes every filename in
that directory, so a changed file is a changed URL and there is nothing to go
stale. Vercel's default for a static build is `max-age=0, must-revalidate`,
which made every online launch re-validate the whole shell **and** the 10 MB
WASM binary — round trips a phone on cellular pays for. This does not affect
offline behaviour either way: Cache Storage ignores HTTP freshness, so the
service worker's `CacheFirst` routes never revalidated in the first place.

`/sw.js` is pinned to `max-age=0, must-revalidate`. That is already Vercel's
default, and it is stated explicitly because it is the one file where a wrong
header is unrecoverable: a service worker cached by the browser for a year
would keep serving an old build to an installed app, with no way for the site
to correct it. `public/` passthrough — the fonts and icons — is deliberately
left at the default, because those filenames are stable rather than hashed
and `immutable` on a name that can be overwritten serves a stale file
forever.

**Note if the headers do not take effect:** Vercel reads `vercel.json` from
the project's configured Root Directory. This file sits in `apps/web/`, which
is correct when Root Directory is `apps/web`. If the project builds from the
repository root instead, move the file there — the contents are unchanged.
Check with:

```bash
curl -sSI https://<your-deployment>/assets/index-<hash>.js | grep -i cache-control
```

## Common test flow

```bash
pnpm typecheck
pnpm test
pnpm --filter @margin/web build
```
