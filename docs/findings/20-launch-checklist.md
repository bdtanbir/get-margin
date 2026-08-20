# Launch checklist — what the test suite cannot tell you

**Status: NOT RUN. Every item below is open.**

Phase 8 closed most of what it set out to close: three browser engines on every commit, zero axe
violations, a bundle budget, telemetry that cannot carry a document. What it could not close is
listed here, in the same form as `docs/findings/17-deploy-verification.md` — what to run, what to
observe, and what a pass looks like, written so a failure is distinguishable from a pass.

**Nothing here is discharged by a green suite.** Four browser projects are not device coverage, one
measured converter is not a load test, and no code change settles a commercial licence. Those are
the three things a launch decision actually turns on, and all three are outside what this
environment can do.

## How to record a result

Append the date, the device or command, what happened, and **pass** or **fail**. "Looked fine on my
phone" is not a result. An item that cannot be run should say so and say why — an item skipped
silently is indistinguishable from an item passed.

---

## 1. Real devices — the one that matters most

`devices['iPhone 13']` in the Playwright config is a viewport, a user-agent string and a touch flag
driving **desktop WebKit on this machine**. It is not iOS Safari. It has no mobile GPU, no mobile
memory ceiling, and no iOS WebKit build. Emulation catches layout and touch-target problems, and
those it has already caught. It cannot catch the thing below.

### 1a. The capacity limits, which have never been validated

`apps/web/src/lib/limits.ts` has carried this comment since Phase 1:

> Revisit after measuring on a mid-range phone — the spec flags this as unvalidated, and phone
> support is a committed requirement.

`MAX_BYTES` is 150 MB and `MAX_PAGES` is 800. Both are guesses. The app holds a document's bytes in
memory, renders pages to bitmaps, and keeps an edit history — on a phone with 3–4 GB of RAM shared
with the OS, the real ceiling could be a quarter of that, and the failure mode is the tab being
killed rather than a message being shown.

**Run:** on a mid-range Android (4 GB RAM, not a flagship) and an iPhone of at least two generations
back, open PDFs at roughly 25 MB, 50 MB, 100 MB, and 150 MB, and a 300-page and 800-page document.
For each: scroll the whole document, rotate a page, add a text box, and export.

**Pass:** the app either completes the work or refuses with the size message from `checkFileSize`.
**Fail:** the tab reloads, the browser kills it, or the export produces a truncated file. A crash is
a fail even if it only happens at 150 MB — that is the number the empty state promises.

**If it fails, lower the constants.** The empty state, the privacy page, and the help panel all read
these from `limits.ts`, so one edit corrects every claim.

### 1b. Touch and gesture behaviour

**Run:** on both devices — pinch-zoom the page, drag to reorder in the pages grid, draw with a
finger, place a signature, and fill a form field. In portrait and landscape.

**Pass:** pinch zooms the page rather than the browser chrome; drag-reorder starts without a
long-press fight against the page scroll; the keyboard does not cover the field being typed into.

### 1c. iOS Safari specifically

**Run:** the whole e2e suite manually, and check: downloading (iOS handles blob downloads
differently), the file picker, and whether the WASM survives a background/foreground cycle.

**Pass:** a download reaches Files, and returning to a backgrounded tab does not lose the document.
This last one is the likeliest failure: iOS discards backgrounded tabs aggressively, and the
autosave path is what has to catch it.

## 2. Load at scale

Single-process converter throughput is measured and recorded in
`docs/findings/19-phase-8-preflight.md`:

| Strategy | Per job |
|---|---|
| Fresh browser per job (what ships) | 160 ms |
| One browser, fresh context per job | 49 ms |

That is the whole of what can be said from here. There is no deployed tier, no Redis, and no
autoscaler, so concurrency, queue depth, and scaling behaviour are unmeasured.

**Run, against a deployed API and worker:** ramp concurrent conversions from 1 to 4× the worker
count. Record throughput, p50/p95/p99 latency, memory per worker, and the queue depth at which
latency stops being linear.

**Pass:** latency degrades gracefully and the rate limiter refuses before the workers thrash.
**Fail:** OOM kills, a queue that grows without bound, or the API becoming unresponsive while
workers are busy — the API and worker are separate containers precisely so the second cannot cause
the first, and this is the test of that claim.

**Then reconsider browser pooling with real numbers.** The 3.2× is real and was deliberately not
taken: a shared browser process across attacker-controlled documents gives up the isolation the
converter design exists to provide (`19-phase-8-preflight.md`, Finding 4). If measured load says
160 ms/job is the bottleneck, that trade can be revisited — with numbers, which is the only way it
should be.

## 3. The Artifex commercial licence

**This gates launch and no test discharges it.** The app ships MuPDF, and `PLAN.md` §8 lists the
licence as a Phase 8 item. AGPL applies otherwise, and this is a hosted web application.

**Do:** confirm the licence covers hosted use and the distribution of the WASM build to browsers,
and record the licence reference here.

**Pass:** a signed agreement, referenced by number. **Fail:** anything else, including "we are
probably fine". There is no partial credit and no engineering workaround.

## 4. Cross-browser, beyond the matrix

The suite runs Chromium, Firefox and WebKit at the versions Playwright pins. That is not the same as
the browsers people have.

**Run:** the app's core path — open, edit, export — on Safari on macOS, Edge, and a Chrome at least
two majors behind current.

**Pass:** no console errors and a byte-identical export. Playwright's WebKit is not Safari, and the
Firefox download bug this phase found is exactly the class of thing that differs between an engine
and the browser built on it.

## 5. Error and telemetry endpoints, if either is configured

Both ship disabled, and the default build has no transport at all. If a deployment configures
`VITE_CONVERT_API` or `VITE_TELEMETRY_ENDPOINT`:

**Run:** with the endpoint pointed at a capture proxy, use the app for ten minutes — open documents
with identifiable names, trigger a failure, export.

**Pass:** every captured payload contains only event names, component names, error types, scrubbed
messages, and counts. **Fail:** any filename, any path, any document content, any identifier that
would link two requests. The unit tests assert this against the serialised bytes
(`test/lib/telemetry.test.ts`), but they assert it about the code — this asserts it about the
deployment.

**Also check** the privacy page in that build. It changes its claims based on what is configured,
and the wrong claim in a live build is worse than no page.

## 6. The things a suite cannot have an opinion about

- **Does the empty state explain what this is** to someone who arrived from a search result?
- **Does the redaction UI make it clear** what was removed and what was not? It is the one feature
  where a misunderstanding has consequences outside the app.
- **Is the consent dialog readable** by someone who is not being careful? It is the only screen
  where that matters, and it is the screen most likely to be clicked through.

**Run:** five people who have not seen the app, one task each, no help. Watch, do not explain.

---

## What passing all of this would mean

That the product works on the hardware people have, under load it will actually see, and is legally
shippable. None of those are claims the test suite makes, and none of them should be inferred from
it being green.
