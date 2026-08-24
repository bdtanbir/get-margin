import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: { baseURL: 'http://localhost:4173', trace: 'on-first-retry' },
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  /**
   * Three engines, every spec, every run.
   *
   * Not nightly and not a pre-release ritual. Firefox was added in Phase
   * 8's pre-flight and failed on the first run: SplitDialog handed the
   * browser a ZIP inside a Blob typed `application/pdf`, Firefox renamed
   * the download to match the Content-Type, and users got a `.pdf` that
   * was actually an archive. That shipped for three phases behind 89 green
   * tests, and the only reason is that nothing ran Firefox.
   *
   * Each engine finishes in well under a minute, so the cost of keeping
   * them here is minutes rather than a reason to defer.
   */
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
      // Needs a touchscreen; the `touch` project below is the one with one.
      testIgnore: '**/gestures.spec.ts',
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } },
      // Desktop-only per its brief, same as the `phone` project below.
      testIgnore: ['**/worker-boot.spec.ts', '**/gestures.spec.ts'],
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } },
      testIgnore: ['**/worker-boot.spec.ts', '**/gestures.spec.ts'],
    },
    /**
     * Real touch gestures, which no other project can drive.
     *
     * The `phone` project below is WebKit, and Playwright's WebKit offers
     * `touchscreen.tap()` and nothing else -- there is no way to express
     * two fingers, so pinch-to-zoom had no coverage at all despite being
     * implemented. Chromium's CDP `Input.dispatchTouchEvent` takes a list
     * of touch points and feeds them through the browser's REAL input
     * pipeline, which means `touch-action` arbitration, native scrolling
     * and momentum all apply exactly as they do on a device. Synthetic
     * `dispatchEvent` touches would bypass all three and prove nothing.
     *
     * Scoped to the gesture spec rather than running the whole suite a
     * fifth time: this project exists for one capability, and every other
     * spec is already covered by a project that shares its engine.
     */
    {
      name: 'touch',
      use: { ...devices['Pixel 7'] },
      testMatch: '**/gestures.spec.ts',
    },
    {
      name: 'phone',
      use: { ...devices['iPhone 13'] },
      // worker-boot.spec.ts (Task 15a) is desktop-only per its brief — the
      // phone project is Task 21's. A `test.skip(testInfo.project.name ===
      // ...)` guard inside the test body is NOT sufficient on its own: the
      // `page` fixture it destructures is resolved by Playwright before the
      // test body runs at all, so the project still launches a browser for
      // it first. `devices['iPhone 13']` defaults to WebKit — when this
      // comment was written it wasn't installed in this environment (only
      // `playwright install chromium` had been run), and the bare `pnpm e2e`
      // command failed with "Executable doesn't exist" on this file under
      // `phone` before `testIgnore` was added, confirming the in-body skip
      // alone doesn't prevent the launch attempt.
      //
      // Update (Task 21, amendment A2): `pnpm --filter @margin/web exec
      // playwright install webkit` has since succeeded, so WebKit IS
      // installed now and `phone` runs real WebKit for every other spec
      // (e2e/viewer.spec.ts). `testIgnore` is kept here regardless — it was
      // never only a WebKit-availability workaround, it also enforces this
      // file's own "desktop only per its brief" design (Task 15a never
      // intended `phone` coverage at all), which installing WebKit doesn't
      // change. Removing it now would just make `phone` launch a browser
      // per test here to immediately `test.skip` every one of them — legal,
      // but pure overhead for a file that was never meant to run there.
      //
      // gestures.spec.ts joins it for an unrelated reason: it drives real
      // two-finger input through Chromium's CDP, which WebKit has no
      // equivalent for. The `touch` project above owns that file.
      testIgnore: ['**/worker-boot.spec.ts', '**/gestures.spec.ts'],
    },
  ],
})
