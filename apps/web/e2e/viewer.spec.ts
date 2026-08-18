import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'

// Task 21: the Phase 1 milestone suite. worker-boot.spec.ts (Tasks 15a/17/
// 18/19/20) already proves the worker/WASM boundary, the render queue, zoom,
// thumbnails, and the shell swap in a real browser — all desktop-only,
// because WebKit was not installed when those specs were written (see the
// `phone` project's `testIgnore` comment in playwright.config.ts). Amendment
// A2 installed WebKit for this task (`pnpm --filter @margin/web exec
// playwright install webkit` succeeded), so this file — unlike
// worker-boot.spec.ts — is NOT desktop-only: every test below runs under
// both the `desktop` and `phone` projects except the one that is
// structurally phone-only (the horizontal-scroll check), which guards
// itself with `test.skip` the same way worker-boot.spec.ts's Task 20 test
// does.

const FIXTURE = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/multi-page.pdf', import.meta.url),
)
const BIG = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/large-300p.pdf', import.meta.url),
)

/**
 * Page 1's canvas, scoped past both places a `<canvas>` can legitimately
 * exist once a document is open: the main viewer (PageCanvas.vue, wrapped in
 * `role="img"` `aria-label="Page N"`) and, on desktop only, ThumbnailPanel's
 * sidebar thumbnails (Thumbnail.vue, `aria-label="Go to page N"` on a
 * `<button>` — a different role, so it can't collide with the selector
 * below, but a bare `page.locator('canvas').first()` cannot tell the two
 * apart by DOM order alone).
 *
 * This is not a hypothetical mistake: the first version of this spec used
 * exactly that bare `.first()` locator (matching the task brief's own
 * example verbatim) and it passed the "renders" and "300-page" checks by
 * accident — those only assert visibility, which either canvas satisfies —
 * but the zoom-size check failed for a real reason: DesktopShell mounts
 * `<ThumbnailPanel>` *before* `<main>` in the DOM (see DesktopShell.vue), so
 * `.first()` silently grabbed a thumbnail's canvas on desktop. A thumbnail
 * renders from the placeholder tier at a size derived from the page's
 * aspect ratio and the panel's fixed 240px column, which does not change
 * when the viewer's zoom changes — so the "size changed after zoom" poll
 * timed out against a canvas that was never going to change size, exactly
 * the "substring locator matching the wrong element" failure mode this
 * project's history warns about. Reusing worker-boot.spec.ts's established
 * `role="img"` scoping here fixes it for the same reason it already works
 * there.
 */
function page1Canvas(page: import('@playwright/test').Page) {
  return page.getByRole('img', { name: 'Page 1', exact: true }).locator('canvas')
}

test('opens a PDF and renders the first page', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Open a PDF' })).toBeVisible()

  await page.setInputFiles('input[type=file]', FIXTURE)

  await expect(page.getByRole('region', { name: 'Document pages' })).toBeVisible()
  // A real canvas means the WASM loaded, rendered, and painted — the whole path.
  await expect(page1Canvas(page)).toBeVisible({ timeout: 30_000 })

  // Page-count metadata parsed correctly. On desktop, ThumbnailPanel's
  // "N pages" header is always mounted alongside the viewer (App.vue ->
  // DesktopShell.vue). On phone, the exact same header lives inside the
  // "Pages" bottom-nav button's full-screen modal (MobileShell.vue) —
  // Task 20's deliberate design choice, not a gap: a phone screen has no
  // room to keep a permanent sidebar, so the panel opens on demand. This
  // spec found that difference by actually failing here under the `phone`
  // project on the first run (this exact assertion, unscoped, timed out
  // waiting for "12 pages" because MobileShell never mounts ThumbnailPanel
  // until `pagesOpen` is true) — the fix is to reach the label the way a
  // real phone user would, by opening the panel first, not to drop the
  // check.
  if (testInfo.project.name === 'phone') {
    await page.getByRole('button', { name: 'Pages' }).click()
  }
  await expect(page.getByText('12 pages')).toBeVisible()
})

test('rejects a non-PDF file', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('input[type=file]', {
    name: 'fake.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('PK this is a zip'),
  })
  await expect(page.getByRole('alert')).toContainText(/not a PDF/i)
})

test('zoom controls change the rendered size', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('input[type=file]', FIXTURE)
  const canvas = page1Canvas(page)
  await expect(canvas).toBeVisible({ timeout: 30_000 })

  // Wait for an actual paint before recording "before", same reasoning as
  // worker-boot.spec.ts's zoom test: a size delta against a canvas that
  // never painted (width/height still 0) would be a false positive.
  await expect
    .poll(async () => (await canvas.boundingBox())?.width ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(0)

  const before = await canvas.boundingBox()
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await expect.poll(async () => (await canvas.boundingBox())?.width, { timeout: 15_000 }).not.toBe(before?.width)
})

test('a 300-page document shows its first page promptly', async ({ page }) => {
  await page.goto('/')
  const start = Date.now()
  await page.setInputFiles('input[type=file]', BIG)
  await expect(page1Canvas(page)).toBeVisible({ timeout: 30_000 })
  // Not a benchmark — a regression guard against accidentally rendering all 300
  // pages before showing anything.
  expect(Date.now() - start).toBeLessThan(20_000)
})

test('the page area does not scroll horizontally on a phone', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone only')
  await page.goto('/')
  await page.setInputFiles('input[type=file]', FIXTURE)
  await expect(page1Canvas(page)).toBeVisible({ timeout: 30_000 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})
