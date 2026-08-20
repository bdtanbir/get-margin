import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { nextZoomStep } from '../src/lib/fit.js'

// Task 21: the Phase 1 milestone suite. worker-boot.spec.ts (Tasks 15a/17/
// 18/19/20) already proves the worker/WASM boundary, the render queue, zoom,
// thumbnails, and the shell swap in a real browser — all desktop-only,
// because WebKit was not installed when those specs were written (see the
// `phone` project's `testIgnore` comment in playwright.config.ts). Amendment
// A2 installed WebKit for this task (`pnpm --filter @margin/web exec
// playwright install webkit` succeeded), so this file — unlike
// worker-boot.spec.ts — is NOT desktop-only: every test below runs under
// both the `desktop` and `phone` projects except the ones that are
// structurally phone-only (the horizontal-scroll check, and the Pages-modal
// dismissal check — DesktopShell has no such modal to dismiss), which guard
// themselves with `test.skip` the same way worker-boot.spec.ts's Task 20
// test does.

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
 * sidebar thumbnails, which since Phase 8 sit inside a `role="option"`
 * tile labelled `Page N` — the SAME accessible name as the viewer canvas,
 * so the role is the only thing telling them apart, and a bare
 * `page.locator('canvas').first()` certainly cannot).
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
  // The empty state is identified by a stable hook, not its heading text:
  // that copy is product wording and changed once already, breaking a dozen
  // selectors across three specs at once.
  await expect(page.locator('[data-empty-state]')).toBeVisible()

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
  expect(before, 'page 1 canvas has no bounding box before zoom').not.toBeNull()

  // worker-boot.spec.ts:294-331 (Task 21's "zoom in changes the rendered
  // page size" test) already fixed exactly this defect once: a bare
  // `not.toBe(before?.width)` inequality check passes on a one-pixel nudge,
  // a shrink, or — the worst case — a canvas that stopped existing, since
  // `boundingBox()` then resolves `undefined`, and `undefined !== number`
  // passes too. That would report success for a zoom that unmounted the
  // page. `ZOOM_STEPS`/`nextZoomStep` (apps/web/src/lib/fit.ts) are pure,
  // Node-importable, so this derives the exact expected pixel width from
  // the same preset table the app uses and asserts equality, mirroring the
  // established pattern rather than reintroducing the inequality-only check.
  const PAGE_WIDTH_PT = 612 // this fixture's Letter page width, in points
  const zoomBefore = before!.width / PAGE_WIDTH_PT
  const expectedZoomAfter = nextZoomStep(zoomBefore, 1)
  const expectedWidthAfter = Math.round(expectedZoomAfter * PAGE_WIDTH_PT)

  await page.getByRole('button', { name: 'Zoom in' }).click()
  await expect
    .poll(async () => (await canvas.boundingBox())?.width, { timeout: 15_000 })
    .toBe(expectedWidthAfter)
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

  // `document.documentElement.scrollWidth - window.innerWidth` cannot detect
  // overflow here: the page area is PageList's own `overflow-auto` scroller
  // (role="region", aria-label="Document pages"), nested inside
  // MobileShell's `<main class="… overflow-hidden">`, inside an `h-dvh`
  // root, under `body { overflow: hidden }` — content inside an
  // `overflow-hidden` ancestor cannot contribute to `documentElement`'s
  // scrollWidth no matter how wide it gets, so that measurement passes even
  // if the scroller itself overflows freely. Measure the scroller directly
  // instead.
  const scroller = page.getByRole('region', { name: 'Document pages' })
  const overflow = await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})

// On phone, ThumbnailPanel renders inside MobileShell's full-screen `fixed
// inset-0` "Pages" modal (see MobileShell.vue), not as a permanent sidebar
// the way it does on desktop. Before this fix, ThumbnailPanel.select() only
// moved the viewport anchor and emitted nothing, so tapping a thumbnail
// moved the (now off-screen, behind the opaque overlay) viewport and left
// the user staring at the same modal with no visible feedback — they had to
// notice nothing happened and go find "Done" themselves. The fix has
// ThumbnailPanel emit `select` after moving the anchor; MobileShell closes
// the modal on it.
test('tapping a thumbnail closes the Pages modal on phone', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone only')
  await page.goto('/')
  await page.setInputFiles('input[type=file]', FIXTURE)
  await expect(page1Canvas(page)).toBeVisible({ timeout: 30_000 })

  await page.getByRole('button', { name: 'Pages' }).click()
  const modal = page.getByRole('dialog', { name: 'Pages' })
  await expect(modal).toBeVisible()

  await modal.getByRole('option', { name: 'Page 8', exact: true }).click()
  await expect(modal).not.toBeVisible()
})
