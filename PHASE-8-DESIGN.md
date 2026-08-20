# Phase 8 — Polish and launch

**Spec:** `PLAN.md` §7 (Phase 8), §4 (privacy), §10. **Pre-flight:** `docs/findings/19-phase-8-preflight.md`.

## 0. What this phase delivers, and what it deliberately does not

Phase 7 was scoped down hard because almost nothing in it could be run. **Phase 8 is not that
situation**, and the pre-flight is explicit about it: Chromium, Firefox and WebKit are all here, axe
runs, and the bundle can be measured. Reaching for the same "cannot verify, will not write"
conclusion a second time would be a habit rather than a judgement.

So the default here is the opposite: **build it, and let the matrix find things.** It already has —
the first Firefox run found a ZIP downloading as a `.pdf`, a defect that had survived three phases
and 89 green tests.

**Built and verified**
- The cross-browser matrix: every e2e spec against Chromium, Firefox and WebKit
- Accessibility fixed at the token level, with axe wired into the suite so the count cannot grow
- A performance budget asserted against the built bundle
- Error reporting that cannot carry user data, off unless configured and consented to
- Usage analytics with the same property, and the same consent
- In-app help

**Written, not verifiable here**
- The launch checklist for real devices, load at scale, and the commercial license

**Not written**
- A marketing site. It is a separate artefact from the application, and building it inside this
  repository would put unrelated deploy surface next to the editor.
- Billing and pricing. Nothing to integrate against; `PLAN.md` itself hedges this with "if
  applicable".

## 1. The cross-browser matrix

Three engines, every spec, on every run. Not a nightly job and not a pre-release ritual: the Firefox
bug was a one-line fix that had been shipped for three phases, and the only reason it survived is
that nothing ran Firefox.

`devices['iPhone 13']` already drives the `phone` project through WebKit, so the matrix is four
projects: `chromium`, `firefox`, `webkit`, `phone`. Roughly 44 specs per engine, and the suite runs
in well under a minute per engine, so the cost is minutes rather than a reason to defer.

**What the matrix cannot do** is stated in §7. Emulated WebKit at an iPhone viewport is not iOS
Safari, and the phase must not let four green projects imply device coverage.

## 2. Accessibility: fix the token, then hold the line

The pre-flight found three violations. Two are single elements; one is a design token.

`--color-text-subtle` is `oklch(0.66 0.01 265)`, which measures **2.83:1** on the sunken surface and
**3.11:1** on white against AA's 4.5:1. It is used across the whole app — including the dialogs
written last phase. **The fix is the token, not the elements axe happened to catch.** Fixing the two
reported nodes would produce a green axe run and leave every other use of the token failing, which
is worse than the current state because it would look resolved.

The token has to move far enough to pass on the lightest background it appears on, and the dark
theme's own subtle token needs the same treatment against its surfaces. Contrast is arithmetic, so
this gets a unit test over the token values themselves rather than only an end-to-end assertion — a
test that computes the ratio and fails with the number.

The other two:

- **The file input has no accessible name.** Critical severity, and it is the control that opens a
  document. `sr-only` hides it visually while leaving it in the tree; it still needs a label.
- **Page tiles are `role="option"` with focusable descendants.** `nested-interactive` is a real
  problem for screen reader users, who get a listbox option that is also a set of buttons.

Then axe runs in the suite, over the empty state and an open document, asserting **zero** violations
at A and AA. A baseline of "no worse than today" would let the count grow one at a time.

## 3. The performance budget

4.8 MB of compressed WebAssembly is what a first-time visitor downloads. That is measurable, so it
is boundable, and the point of the bound is to fail a build rather than to be noticed after release.

The budget asserts on the built output, in the unit suite, so it runs without a browser. Two numbers:
the application bundle and the total. The WASM is what it is — MuPDF is the product — so the budget's
job is to stop it drifting, not to pretend it can shrink.

**The budget must be set at or below today's size.** A budget set above the current number so it
passes on the day it is written is a comment, not a control.

## 4. Error reporting that cannot carry user data

The privacy page says there is no analytics on your documents. An error reporter is the easiest way
to make that false by accident: stack traces, error messages built from user input, and
"context" objects all routinely carry filenames and content.

So the reporter has the same shape as the API's logger, and for the same reason — **an allowlist,
not a redaction list**. A report carries an event name, a component, an error type, a message that
has been through a scrubber, and a schema version. There is no free-form context object, because a
context object is where a filename ends up.

The scrubber matters because messages are not fully controllable: `PdfOpenError`'s message is fixed,
but a message can interpolate a font family, a page label, or a path. It removes anything shaped like
a filename, a path, or a long token.

**No transport by default.** Exactly like `CONVERT_API_BASE`: with nothing configured there is no
endpoint, nothing is sent, and the privacy claim stays literally true. When a deployer configures
one, the user is asked once, plainly, and the answer defaults to no.

## 5. Analytics with the same rule

Same module, same constraints, different events. Counts of which features are used, never what they
were used on. No document identifiers, no file sizes that could fingerprint a specific document, no
IP-derived anything the client can control.

Opt-in, not opt-out. This is the one product decision here that costs something real — most people
will not opt in, so the numbers will be partial — and it is the only one consistent with everything
else the product says. A privacy page that promises no document analytics next to an opt-out
analytics toggle is a page nobody should believe.

## 6. In-app help

A help panel: what the app does, the keyboard shortcuts, and the answers to the questions the design
has been deferring to comments. It reads from the same command registry the palette uses, so a
shortcut cannot be documented as one thing and bound to another.

## 7. What cannot be verified here

`docs/findings/20-launch-checklist.md`, in the same style as the deploy checklist: what to run, what
to observe, what a pass looks like.

- **Real devices.** iOS Safari and Android Chrome on real hardware, specifically to validate
  `MAX_BYTES` and `MAX_PAGES`, which have carried an "unvalidated on real hardware" comment since
  Phase 1. A 150 MB PDF on a phone is a memory question, and emulation has no memory ceiling to hit.
- **Load at scale.** Single-process converter throughput is measured (160 ms/job); concurrency,
  queue depth and autoscaling need a deployed tier.
- **The Artifex commercial license.** A commercial action. No code discharges it, and the app ships
  MuPDF, so it gates launch regardless of what the tests say.

## 8. Testing

- The matrix is the test: every existing spec, three engines.
- Contrast is tested as arithmetic on the token values, so a failure reports the ratio.
- axe runs against two real application states and asserts zero.
- The bundle budget asserts on the built files, with the numbers in the failure message.
- The reporter is tested the way the logger was: hand it a filename and assert the filename does not
  appear in the payload bytes. The failure mode is silent, so the test has to look.
- Consent for reporting and analytics is tested for what it says, not that it exists — the same
  standard Phase 7 applied to the upload consent.
