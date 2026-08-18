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
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    {
      name: 'phone',
      use: { ...devices['iPhone 13'] },
      // worker-boot.spec.ts (Task 15a) is desktop-only per its brief — the
      // phone project is Task 21's. A `test.skip(testInfo.project.name ===
      // ...)` guard inside the test body is NOT sufficient on its own: the
      // `page` fixture it destructures is resolved by Playwright before the
      // test body runs at all, so the project still launches a browser for
      // it first. `devices['iPhone 13']` defaults to WebKit, which isn't
      // installed in this environment (only `playwright install chromium`
      // was ever run) — the bare `pnpm e2e` command failed with "Executable
      // doesn't exist" on this file under `phone` before this was added,
      // confirming the in-body skip alone doesn't prevent the launch
      // attempt. `testIgnore` here stops Playwright from ever trying to run
      // this file under `phone`, regardless of WebKit's install state.
      testIgnore: '**/worker-boot.spec.ts',
    },
  ],
})
