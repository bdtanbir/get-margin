import { test, expect } from '@playwright/test'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The performance budget, asserted against the built output.
 *
 * It lives in the e2e directory rather than the unit suite for one
 * practical reason: Playwright's `webServer` builds before any spec runs,
 * so `dist/` is guaranteed to exist and to be current. The unit suite runs
 * BEFORE `pnpm -r build` in the gate order, so the same check there would
 * fail on a fresh clone for a reason that has nothing to do with size.
 *
 * It needs no browser and only runs on one project -- four identical
 * readings of the same files would be three wasted.
 */

const DIST = fileURLToPath(new URL('../dist', import.meta.url))

/**
 * Gzip, not raw bytes.
 *
 * Every host worth deploying to serves compressed, so raw size measures
 * something no user waits for. Brotli would be closer still, but gzip is
 * the floor every host supports and the conservative number to bound.
 */
function gzippedSize(path: string): number {
  return gzipSync(readFileSync(path), { level: 9 }).byteLength
}

type Bundle = { app: number; wasm: number; total: number; files: Array<[string, number]> }

/**
 * Build output that lands in `dist/` root rather than `dist/assets/`.
 *
 * The service worker and its workbox runtime are code this app ships and
 * every visitor downloads, so they belong in the budget — but they are
 * emitted beside index.html, where the `assets/` walk below cannot see
 * them. Without this list a precache manifest could grow without bound and
 * the size gate would report no change at all.
 *
 * `public/` passthrough (fonts, icons, favicon.svg) stays out, exactly as
 * it always has: those are fetched on demand or by the OS at install time,
 * not on the path to first paint.
 */
const ROOT_OUTPUT = /^(index\.html|sw\.js|workbox-[^/]+\.js|manifest\.webmanifest)$/

function measure(): Bundle {
  const assets = join(DIST, 'assets')
  const files: Array<[string, number]> = []
  let app = 0
  let wasm = 0

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      const size = gzippedSize(full)
      files.push([entry, size])
      if (entry.endsWith('.wasm')) wasm += size
      else app += size
    }
  }
  walk(assets)

  for (const entry of readdirSync(DIST)) {
    if (!ROOT_OUTPUT.test(entry)) continue
    const size = gzippedSize(join(DIST, entry))
    files.push([entry, size])
    app += size
  }

  return { app, wasm, total: app + wasm, files: files.sort((a, b) => b[1] - a[1]) }
}

const KB = 1024

/**
 * The budgets.
 *
 * Set just above what the code measures today, not at a round number
 * somebody hoped for. A budget written comfortably above the current size
 * passes on the day it is written and never means anything again; one set
 * exactly at the current byte count fails on the next honest commit. The
 * headroom here is a few percent -- enough for a feature, not enough for a
 * dependency nobody noticed.
 *
 * Raising these should be a deliberate edit with a reason in the commit
 * message. The failure message below gives the numbers needed to write one.
 */
const BUDGET = {
  /**
   * Everything we author: JS, CSS, the worker, the HTML shell, and the
   * service worker.
   *
   * Raised from 260 KB when the PWA landed. That cost ~9 KB gzipped in
   * total: workbox-window (2.4 KB) to talk to the service worker, the
   * generated `sw.js` and its workbox runtime, the update prompt, and the
   * launch-queue handler. Bought with it: the app installs, opens PDFs
   * from the OS, and runs with no network. The 3% headroom above is the
   * same margin the other two carry — room for a feature, not for a
   * dependency nobody noticed.
   */
  app: 272 * KB,
  /**
   * MuPDF. It is the product -- there is no version of this app that reads
   * PDFs without it -- so this bound exists to catch it changing, not in
   * the hope of shrinking it.
   */
  wasm: 4700 * KB,
  total: 4962 * KB,
}

function human(bytes: number): string {
  return bytes >= KB * KB ? `${(bytes / KB / KB).toFixed(2)} MB` : `${(bytes / KB).toFixed(1)} KB`
}

function overBudget(name: string, actual: number, budget: number, files: Bundle['files']): string {
  const delta = actual - budget
  return [
    ``,
    `${name} is ${human(actual)} gzipped, over the ${human(budget)} budget by ${human(delta)}.`,
    ``,
    `Largest files:`,
    ...files.slice(0, 6).map(([f, s]) => `  ${human(s).padStart(10)}  ${f}`),
    ``,
    `If the growth is intended, raise the budget in e2e/bundle.spec.ts and say why.`,
    ``,
  ].join('\n')
}

/** One project is enough: this reads files from disk and never opens a page. */
const DESKTOP_ONLY = 'reads the build from disk; one project is enough'

test.describe('bundle size', () => {
  test('the built output is within budget', async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', DESKTOP_ONLY)

    // Loud, not skipped. A size gate that silently passes when it cannot
    // find the build reports success for the one state it can never
    // verify.
    expect(
      existsSync(DIST),
      `No build found at ${DIST}. Run \`pnpm --filter @margin/web build\` first.`,
    ).toBe(true)

    const bundle = measure()

    // Reported on every run, so the number is visible in a passing log
    // rather than only in a failure.
    console.log(
      `\nbundle: app ${human(bundle.app)} / ${human(BUDGET.app)}  ` +
        `wasm ${human(bundle.wasm)} / ${human(BUDGET.wasm)}  ` +
        `total ${human(bundle.total)} / ${human(BUDGET.total)}  (gzipped)`,
    )

    expect(bundle.app, overBudget('Application code', bundle.app, BUDGET.app, bundle.files))
      .toBeLessThanOrEqual(BUDGET.app)
    expect(bundle.wasm, overBudget('WebAssembly', bundle.wasm, BUDGET.wasm, bundle.files))
      .toBeLessThanOrEqual(BUDGET.wasm)
    expect(bundle.total, overBudget('Total', bundle.total, BUDGET.total, bundle.files))
      .toBeLessThanOrEqual(BUDGET.total)
  })

  /**
   * A budget that cannot be exceeded is not measuring anything.
   *
   * If the build ever emits nothing -- a misconfigured output directory, a
   * plugin that silently drops assets -- every assertion above would pass
   * on zero bytes. This is the control that makes the others mean
   * something, the same argument as the redaction suite's "the extractor
   * can still read unredacted text" check.
   */
  test('the measurement is actually finding the build', async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', DESKTOP_ONLY)

    const bundle = measure()
    expect(bundle.files.length, 'no assets found — is the build output empty?').toBeGreaterThan(3)
    expect(bundle.wasm, 'no wasm found — MuPDF should dominate this build').toBeGreaterThan(
      1000 * KB,
    )
    expect(bundle.app, 'no application code found').toBeGreaterThan(50 * KB)
  })
})
