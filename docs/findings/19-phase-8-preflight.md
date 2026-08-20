# Phase 8 pre-flight — what launch readiness can actually be measured here

Phase 7's pre-flight asked which parts of the phase could be *run*. The answer there was "not many",
and the phase was scoped down accordingly. **Phase 8 is the opposite case**, and it is worth saying
so plainly rather than reaching for the same conclusion twice: the headline capability of this phase
— running the product in the browsers people actually use — is fully available here, and it found
real defects within minutes of being pointed at the app.

## What is available

| Thing | Status | Consequence |
|---|---|---|
| Chromium | present | Already the e2e baseline |
| **Firefox 153** | **installed during this pre-flight** | **A real cross-browser matrix is runnable** |
| **WebKit** | present | Already used by the `phone` project |
| `@axe-core/playwright` | **installs and runs** | Automated WCAG auditing is verifiable |
| Bundle/network measurement | via Playwright | A performance budget can be enforced in CI |
| Real phones and tablets | **absent** | Device emulation is not device testing. Cannot be closed here |
| Deployed worker tier | **absent** | Load testing is local-only; no autoscaling to measure |
| Artifex commercial license | n/a | A commercial action, not an engineering one |
| Billing / payments | absent | Nothing to integrate against |

## Finding 1 — the cross-browser matrix works, and it immediately found a bug

The full e2e suite, run against each engine:

```
chromium (desktop + phone)   89 passed,  4 skipped
webkit   (desktop)           40 passed,  4 skipped
firefox  (desktop)           39 passed,  1 FAILED,  4 skipped
```

The Firefox failure is a genuine user-facing defect, not a test artefact:

```
splits into a zip
  Expected: "multi-page-split.zip"
  Received: "multi-page-split.pdf"
```

`SplitDialog` handed the browser a ZIP archive inside a Blob typed `application/pdf`, because
`downloadBytes` defaults its MIME to PDF and the split path never overrode it. **Firefox renames a
download to match the blob's Content-Type.** So splitting a document in Firefox produced
`multi-page-split.pdf` — a ZIP archive wearing a `.pdf` extension, which does not open.

Chromium and WebKit both honour the `download` attribute and keep `.zip`, which is why this survived
three phases and 89 passing e2e tests. **Fixed during this pre-flight**, and it is the argument for
the whole phase: a cross-browser matrix is not paperwork, it is the only thing that finds this class
of bug.

Notably `ImageExport`, written in Phase 7, passes `MIME.zip` explicitly and was never affected. The
defect was in the older code path that predates the MIME parameter.

## Finding 2 — three real WCAG violations, one of them systemic

`@axe-core/playwright` against WCAG 2.0/2.1 A and AA, on the empty state and with a document open:

| Rule | Impact | Where |
|---|---|---|
| `color-contrast` | serious | `text-text-subtle` — **2.83:1** on the sunken surface, **3.11:1** on white. AA needs 4.5:1 |
| `label` | **critical** | The file input has no accessible name at all — no label, no `aria-label`, no title |
| `nested-interactive` | serious | Page tiles are `role="option"` with focusable descendants |

The contrast one is the important finding, because it is **not one element**. `--color-text-subtle`
is a design token (`oklch(0.66 0.01 265)`), and every use of `text-text-subtle` across the app fails
AA — including the dialogs written in Phase 7. Fixing the token fixes all of them at once; fixing the
two elements axe happened to catch would leave the rest broken, and would be the kind of green that
means nothing.

The `label` violation is critical severity and sits on the app's front door: the control that opens a
document is unusable by name to a screen reader.

## Finding 3 — first load is 10 MB of WebAssembly

```
transferred on first load   9.93 MB, of which wasm 10,165 KB
build output                mupdf-wasm  10,408 KB raw / 4,760 KB gzip
                            index.js       583 KB raw /   190 KB gzip
FCP (localhost)             webkit 183 ms, firefox 352 ms
```

The shell paints quickly — FCP is well under half a second and `load` fires at 76–154 ms — so the
engine arrives after the UI is already up. But the number that matters for a launch is the 4.8 MB
compressed WASM a first-time visitor downloads before they can open anything, and on a slow
connection that is the whole first impression.

This is measurable, so it is boundable: a size budget asserted in CI turns "the bundle grew" from
something noticed after release into something that fails a build. What the budget must **not** do is
be set above the current size and called a pass.

## Finding 4 — pooling the browser is 3.2× faster, and should probably not be done

The HTML converter launches a fresh Chromium per job. Measured over five conversions of a
200-paragraph document:

| Strategy | Per job |
|---|---|
| Fresh browser per job (what ships) | **160 ms** |
| One browser, fresh context per job | **49 ms** |

Launch alone is 199 ms; close is 84 ms. Pooling is a 3.2× throughput win and it is the obvious
optimisation to reach for under "load testing the worker tier".

**The recommendation is not to take it, at least not by default.** A fresh context gives storage
isolation, not process isolation: every job would share one browser process with every other job's
attacker-controlled input. This project's entire argument for the converter design — JavaScript off,
network dead, properties of the runtime rather than of a sanitiser — is that untrusted documents get
no shared state to reach. 160 ms per job is not the bottleneck that justifies giving that up, and
there is no measured load here that says otherwise.

Recorded as a measured trade rather than an omission, so whoever has real traffic can revisit it with
numbers instead of rediscovering the 3.2×.

## Finding 5 — what cannot be closed here, and must not be claimed

- **Real-device testing.** `devices['iPhone 13']` is a viewport, a user agent, and a touch flag
  driving desktop WebKit. It is not iOS Safari, it has none of the memory ceiling that makes a
  150 MB PDF interesting on a real phone, and `MAX_BYTES`/`MAX_PAGES` in `lib/limits.ts` still carry
  their original comment saying they are unvalidated on real hardware. Emulation can catch layout
  and touch-target problems. It cannot validate those caps, and this phase must not pretend it did.
- **Load testing a worker tier.** There is no deployed tier, no Redis, no autoscaler. Single-process
  throughput can be measured, and was (Finding 4). Anything about concurrency, queue depth, or
  scaling would be fiction.
- **The Artifex commercial license.** A commercial negotiation. It belongs on the launch checklist,
  not in a task list, and no code change discharges it.
- **Billing and pricing.** Nothing to integrate against, and `PLAN.md` already hedges it with "if
  applicable".

## Recommendation

Phase 8's verifiable core is larger than Phase 7's, so the shape is different: **build it, and let
the matrix find things.** Specifically —

1. **Add Firefox and WebKit to the e2e matrix properly.** It has already paid for itself once.
2. **Fix the accessibility violations at the token level**, and wire axe into the suite so the count
   cannot silently grow.
3. **Assert a performance budget** on the built bundle.
4. **Error reporting and analytics that are honest by construction** — no third-party transport by
   default, nothing that contradicts the privacy page, and opt-in rather than opt-out.
5. **In-app help**, which needs nothing this environment lacks.
6. **State the unverifiable items** — real devices, load at scale, the license — in one place, with
   what would have to be run, in the same style as `17-deploy-verification.md`.

The one thing to avoid is repeating Phase 7's conclusion out of habit. Most of this phase *can* be
verified here, and the parts that cannot are a short, nameable list rather than the bulk of the work.
