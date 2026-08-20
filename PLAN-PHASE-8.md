# Phase 8 — Polish and launch, Implementation Plan

> **For agentic workers:** implement task-by-task. Each task ends green on all four gates
> (`pnpm test`, `pnpm -r typecheck`, `pnpm -r build`, `pnpm --filter @margin/web e2e`) and commits.

**Goal:** The product is ready to be seen by people who did not build it — in the browsers they
use, with the accessibility they need, and without any telemetry that contradicts the privacy page.

**Spec:** `PHASE-8-DESIGN.md`. **Pre-flight:** `docs/findings/19-phase-8-preflight.md`.

## Global Constraints

- **Nothing new may contradict the privacy page.** Anything that could transmit is off unless
  configured AND consented to, and the page's claims stay conditional on that. `PLAN.md` §4.
- **Allowlists, not redaction lists**, for anything that leaves the device — the rule the API's
  logger already follows.
- **A budget or a baseline set to today's failing number is not a control.** Contrast, bundle size,
  and axe counts are all asserted at the value they should be, not the value they are.
- **Do not claim device coverage from emulation.** `PHASE-8-DESIGN.md` §7.
- **No marketing site, no billing.** Design §0.

---

## Task 107: The cross-browser matrix

**Files:** modify `apps/web/playwright.config.ts`; `docs/findings/19-phase-8-preflight.md` needs no change

- [ ] Projects: `chromium`, `firefox`, `webkit`, `phone`. Keep the existing `worker-boot.spec.ts`
      exclusion and its reasoning.
- [ ] Every spec runs on every engine, on every run. Not nightly — the Firefox bug survived three
      phases precisely because nothing ran Firefox.
- [ ] Confirm the whole suite is green on all four projects, and record the per-engine counts.
- [ ] Gates, commit.

## Task 108: Contrast, fixed at the token

**Files:** modify `apps/web/src/app/styles/tokens.css`; create `apps/web/src/lib/contrast.ts`,
test `apps/web/test/lib/contrast.test.ts`

**Produces:** `contrastRatio()`, `relativeLuminance()`, and tokens that pass AA.

- [ ] `--color-text-subtle` measures 2.83:1 on the sunken surface and 3.11:1 on white. Move it until
      it passes 4.5:1 on **every** surface it is used on, light and dark.
- [ ] Check `--color-text-muted` at the same time rather than waiting for axe to report it next.
- [ ] `contrastRatio` implements WCAG's own formula, in a unit test over the real token values, so a
      failure reports the ratio and the pair rather than "axe found something".
- [ ] Tests: every text token against every surface token it can appear on, both themes; the helper
      itself against WCAG's published reference pairs.
- [ ] Gates, commit.

## Task 109: The other two violations

**Files:** modify the file input's component and `apps/web/src/features/pages/PageGrid.vue`

- [ ] The file input has no accessible name — critical, and it is the control that opens a document.
      `sr-only` keeps it in the tree, so it needs a real label.
- [ ] Page tiles are `role="option"` with focusable descendants. Resolve the nesting rather than
      removing the role, so keyboard and screen reader behaviour survives.
- [ ] Tests: the input has an accessible name; the tile exposes one interactive element to the
      accessibility tree.
- [ ] Gates, commit.

## Task 110: axe in the suite, asserting zero

**Files:** create `apps/web/e2e/a11y.spec.ts`

- [ ] WCAG 2.0/2.1 A and AA, against the empty state and an open document.
- [ ] **Zero violations, not a baseline.** "No worse than today" lets the count grow one at a time.
- [ ] Failure output names the rule, the impact, and the element, or the report is unusable.
- [ ] Runs on every engine in the matrix — contrast is the same everywhere, focus and roles are not.
- [ ] Gates, commit.

## Task 111: The performance budget

**Files:** create `apps/web/test/bundle.test.ts`, modify `vitest.workspace.ts` if needed

- [ ] Assert on the built output: application bundle and total, gzipped.
- [ ] **Set at or below today's numbers.** A budget written above the current size passes on the day
      it is written and never again means anything.
- [ ] The failure message carries both numbers and the delta, so the next person knows what grew.
- [ ] Skips loudly, with instructions, if the build has not been run — a budget that silently passes
      on a missing `dist/` is worse than none.
- [ ] Gates, commit.

## Task 112: Error reporting that cannot carry user data

**Files:** create `apps/web/src/lib/telemetry/{types.ts,scrub.ts,reporter.ts}`;
tests `apps/web/test/lib/telemetry.test.ts`

- [ ] An allowlist-shaped event: name, component, error type, scrubbed message, schema version.
      **No free-form context object** — that is where a filename ends up.
- [ ] `scrub()` removes anything shaped like a filename, a path, or a long token.
- [ ] **No transport by default**, exactly like `CONVERT_API_BASE`. Nothing configured, nothing sent.
- [ ] Tests: hand the reporter a filename in every field it accepts and assert the filename does not
      appear in the serialised payload — the failure is silent, so the test reads the bytes. A
      report with no endpoint configured sends nothing. Consent withheld sends nothing.
- [ ] Gates, commit.

## Task 113: Analytics, opt-in, and the consent that gates both

**Files:** create `apps/web/src/lib/telemetry/analytics.ts`,
`apps/web/src/features/settings/TelemetryConsent.vue`;
tests `apps/web/test/features/TelemetryConsent.test.ts`

- [ ] Feature-usage counts only. Never what a feature was used on, never a document identifier, never
      a size that could fingerprint one.
- [ ] Opt-in, not opt-out, and the dialog says what is and is not collected in plain words.
- [ ] The choice is remembered — unlike upload consent, which is per action by design. Say why in the
      code, because the two are deliberately different.
- [ ] Tests: nothing is sent before a choice is made; declining is remembered and sends nothing;
      accepting sends counts and no identifiers; the copy names what is collected.
- [ ] Gates, commit.

## Task 114: In-app help

**Files:** create `apps/web/src/features/help/HelpPanel.vue`;
test `apps/web/test/features/HelpPanel.test.ts`

- [ ] What the app does, what stays on the device, and the keyboard shortcuts.
- [ ] Shortcuts read from the same command registry the palette uses, so a shortcut cannot be
      documented as one thing and bound to another.
- [ ] Tests: every command with a shortcut appears; the listed key matches the binding; it is
      reachable and focus-trapped like every other panel.
- [ ] Gates, commit.

## Task 115: The launch checklist — what this environment cannot close

**Files:** create `docs/findings/20-launch-checklist.md`

- [ ] Real devices: iOS Safari and Android Chrome, specifically to validate `MAX_BYTES` and
      `MAX_PAGES`, which have carried an "unvalidated on real hardware" comment since Phase 1.
- [ ] Load at scale: what to run against a deployed tier, and what the measured single-process
      numbers already are so the comparison is possible.
- [ ] The Artifex commercial license, named as a launch gate no test discharges.
- [ ] Same style as `17-deploy-verification.md`: what to run, what to observe, what a pass looks
      like. No test, because there is nothing here to run.
- [ ] Gates, commit.

## Task 116: Phase verification

**Files:** create `docs/findings/21-phase-8-verification.md`; modify `PLAN.md` §7

- [ ] All four gates, with per-engine e2e counts.
- [ ] Record what the matrix found, what it cannot cover, and what remains open at launch.
- [ ] Commit, merge to master.

---

## Plan self-review

**Design coverage.** §1 → 107, 110. §2 → 108, 109, 110. §3 → 111. §4 → 112. §5 → 113. §6 → 114.
§7 → 115. §8 is distributed.

**Ordering.** The matrix first, because every later task's tests run inside it. Contrast before axe,
because axe would otherwise fail on the token and the token fix is the interesting one. The budget
is independent. Telemetry before its consent UI, since the UI gates the module. Help last, because
it documents what the earlier tasks settled.

**The risk in this phase is the opposite of Phase 7's.** There, the danger was writing code that
could not be verified. Here it is *declaring* things verified that emulation only approximates —
four green browser projects are not device coverage, and one measured converter is not a load test.
Task 115 exists so those stay named rather than implied.
