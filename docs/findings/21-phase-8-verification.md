# Phase 8 verification — polish and launch

Tasks 107–116. **1,626 unit tests, 186 e2e across four browser projects**, clean `tsc`, `vue-tsc`,
and build. Phase 7 ended at 1,542 unit and 89 e2e on two engines.

## The headline: the matrix earns its keep immediately

Phase 7 was scoped down because almost nothing in it could be run here. The easy mistake in Phase 8
was to reach for that conclusion a second time out of habit. The pre-flight checked instead, and
found the opposite: Chromium, Firefox and WebKit are all available, axe runs, and the bundle can be
measured.

**Running the existing suite against Firefox for the first time failed on the first attempt, and
correctly.** `SplitDialog` handed the browser a ZIP inside a Blob typed `application/pdf`, because
`downloadBytes` defaults its MIME to PDF and the split path never overrode it. Firefox renames a
download to match the Content-Type, so splitting a document produced `multi-page-split.pdf` — a ZIP
archive wearing a `.pdf` extension, which does not open.

That shipped for three phases behind 89 passing e2e tests. The only reason it survived is that
nothing ran Firefox. `ImageExport`, written one phase earlier, passes `MIME.zip` explicitly and was
never affected — the bug was in the older path that predates the parameter.

The matrix now runs on every commit rather than nightly, for exactly that reason: a matrix that runs
before a release finds this bug at the worst possible moment.

## Accessibility: three violations, two of them structural

| Rule | Impact | What it actually was |
|---|---|---|
| `color-contrast` | serious | A design token, not two elements |
| `label` | critical | The control that opens a document had no accessible name |
| `nested-interactive` | serious | A listbox with no keyboard support at all |

**Contrast was a token.** `--color-text-subtle` measured 2.84:1 on canvas against AA's 4.5:1, and it
is used 28 times including in the dialogs written last phase. Fixing the two nodes axe reported
would have produced a green audit and left every other use failing — green that means nothing.

oklch is perceptually uniform and says nothing about sRGB relative luminance, which is what WCAG
measures: `oklch(0.66)` reads as comfortably mid-range and is not. So `lib/contrast.ts` converts the
way a browser does and applies WCAG's formula, pinned against colours a real browser painted
(`#8f9299` on `#f4f4f6` at 2.83:1, which axe reported while auditing the running app).

**Both lower steps moved.** Raising `subtle` to a passing 0.535 alone would have put it within 0.005
of `muted` — two legible colours indistinguishable from each other, which is not what a three-level
type scale is for. Light is now 0.23 / 0.44 / 0.535, dark 0.95 / 0.75 / 0.655, each with margin
above the threshold rather than sitting on it.

**`nested-interactive` was the interesting one**, because resolving it properly meant confronting
something bigger. The pages grid was a `role="listbox"` whose options were not focusable and which
had no key handling at all — the only way in was tabbing to the buttons nested inside each tile, and
one of those had `@select="() => {}"`, so a keyboard user could tab to a control that did nothing.
Removing the nesting without adding keyboard support would have taken the grid from badly reachable
to unreachable. The tile is now the option, with a roving tabindex, arrows, Space to toggle, Enter to
navigate, and Shift+arrow to extend.

It also took two attempts. `tabindex="-1"` plus `aria-hidden` still failed, and axe says why in as
many words: a negative tabindex inside an interactive control "does not prevent assistive
technologies from focusing the element (even with aria-hidden=true)". Only a non-focusable element
resolves it.

**axe now reports zero at A and AA** on the empty state, an open document, and the pages grid, on
every engine. Zero rather than a recorded baseline: a baseline is how an audit becomes decoration,
because each new violation is one more than yesterday and the number only goes up.

## Covered on every commit

| Area | Check | Where |
|---|---|---|
| Cross-browser | Every spec on Chromium, Firefox, WebKit, and an emulated phone | `playwright.config.ts` |
| Accessibility | axe at WCAG A + AA, zero violations, three application states, four engines | `e2e/a11y.spec.ts` |
| Accessibility | Page selection by keyboard alone, in a real browser | `e2e/a11y.spec.ts` |
| Contrast | Every text token against every surface, both themes, reporting the ratio and hex pair | `test/lib/contrast.test.ts` |
| Contrast | The three text steps stay apart and in order | `test/lib/contrast.test.ts` |
| Contrast | The oklch conversion still matches what a browser paints | `test/lib/contrast.test.ts` |
| Bundle | app / wasm / total gzipped, with the largest files named on failure | `e2e/bundle.spec.ts` |
| Bundle | The measurement is finding a real build, not passing on zero bytes | `e2e/bundle.spec.ts` |
| Telemetry | A filename pushed into every accepted field never reaches the payload bytes | `test/lib/telemetry.test.ts` |
| Telemetry | No endpoint and no consent are each independently sufficient to send nothing | `test/lib/telemetry.test.ts` |
| Telemetry | Consent withdrawn between queue and flush stops the send | `test/lib/telemetry.test.ts` |
| Consent | Lists what is collected from the same constant the code counts against | `test/features/TelemetryConsent.test.ts` |
| Consent | A dismissal is recorded as no, never as unanswered | `test/features/TelemetryConsent.test.ts` |
| Consent | Neither button is weighted toward yes | `test/features/TelemetryConsent.test.ts` |
| Privacy page | Its upload and analytics claims track what the build can actually do | `test/features/PrivacyPage.test.ts` |
| Help | Every documented shortcut is one that is actually bound | `test/features/HelpPanel.test.ts` |
| Help | Redo is registered before undo, which was previously only a comment | `test/features/HelpPanel.test.ts` |

## Two claims that now change with the build

The privacy page said "nothing is uploaded, and there is no server to upload it to" and "there are
no accounts, no analytics". Both were true of the shipped build and would have become false in a
build with a converter or a telemetry endpoint configured.

Both are now conditional on what is configured, and the build that *does* have a service names the
exception and its policy instead. Both branches have tests. Phase 6 had to fix this page once
already for understating what gets stored; this was the same failure pointed the other way, twice.

**The shipped build still sends nothing.** `VITE_CONVERT_API` and `VITE_TELEMETRY_ENDPOINT` are both
empty by default, and with nothing configured no transport is constructed at all — the absence is
structural rather than a flag being checked.

## Things found by writing the tests, not by review

- **Vitest stubs CSS imports to empty**, so a `?raw` import of the token file silently yielded
  nothing and every contrast assertion would have passed over zero tokens.
- **Splitting the stylesheet on the first occurrence of `[data-theme='dark']`** matched the header
  comment explaining the theme swap, putting every token in the "dark" half — where
  first-definition-wins returned the light values and the dark assertions passed against the wrong
  colours. Both now have guards.
- **A comment at a Vue template's root** makes the component render as a fragment, silently breaking
  attribute inheritance and every `wrapper.attributes()` assertion against it. Nine test failures.
- **Scrubbing telemetry event names broke them.** `export.pdf` is a good event name and the filename
  rule ate it, because a lowercase word with a dot and an extension is exactly what a filename looks
  like. No scrubber can tell them apart, so names are validated against a shape a filename cannot
  have, with colons instead of dots.
- **Mocking a Vue computed as a plain object with a `.value`** looks right and is not — Vue only
  auto-unwraps real refs, so the template read `undefined` and the test passed for the wrong reason.

## Known limits, stated

- **One flaky test, unreproduced.** `worker/test/html.test.ts > renders unclosed and nonsense markup`
  failed once in roughly ten full-suite runs and did not recur in six subsequent full runs or three
  worker-only runs. The plausible cause is the converter's 30-second wall clock firing under
  contention when four Vitest projects and Chromium compete for cores — which would be the timeout
  working as designed in a test that assumes it will not fire. **This is a hypothesis, not a
  diagnosis**; no code was changed to chase it, because changing a test to suppress an unreproduced
  failure is how a real defect gets hidden.
- **The bundle is 4.77 MB gzipped**, of which 4.53 MB is MuPDF. The budget bounds it against drift;
  it is not a plan to shrink it, and there is no version of this product that reads PDFs without it.
- **Telemetry numbers will be partial.** Opt-in means most people will not opt in, and the counts
  will skew toward people comfortable being counted. That is the cost of the only setting consistent
  with the privacy page.

## Not closed here, and named rather than implied

`docs/findings/20-launch-checklist.md`. Three things a green suite does not settle:

1. **Real devices.** `MAX_BYTES` (150 MB) and `MAX_PAGES` (800) have carried an "unvalidated on real
   hardware" comment since Phase 1. Playwright's iPhone project is a viewport and a user-agent string
   driving desktop WebKit on this machine; it has no mobile memory ceiling to hit, which is the
   entire question. The failure mode is the tab being killed, not a message being shown.
2. **Load at scale.** Single-process converter throughput is measured (160 ms/job, and 49 ms with a
   pooled browser). Concurrency, queue depth and autoscaling need a deployed tier. The 3.2× pooling
   win was deliberately not taken — a shared browser process across attacker-controlled documents
   gives up the isolation the converter design exists to provide — and is recorded so it can be
   revisited with numbers rather than rediscovered.
3. **The Artifex commercial licence.** A commercial action that gates launch and that no code
   discharges.

Also out of scope, per the design: a marketing site (a separate artefact from the application) and
billing (nothing to integrate against, and `PLAN.md` hedges it with "if applicable").

## Gates

```
pnpm test                      1,626 passed, 1 skipped, 125 files
pnpm -r typecheck              tsc, tsc, vue-tsc — clean
pnpm -r build                  clean
pnpm --filter @margin/web e2e  186 passed, 19 skipped, 4 projects
bundle                         app 246.7 KB / 260 KB, wasm 4.53 MB / 4.59 MB (gzipped)
```
