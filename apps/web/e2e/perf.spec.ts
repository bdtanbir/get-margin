import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const LARGE = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/large-300p.pdf', import.meta.url),
)

/**
 * Measurement, not assertion.
 *
 * Every cap in this app is a hand-chosen constant, and tuning them against
 * imagined conditions is how they end up wrong. This prints numbers for
 * docs/findings/10-large-document-performance.md and asserts only the
 * loose bounds that would represent an actual regression.
 *
 * Desktop only: the phone project shares the same engine, and running it
 * twice doubles the slowest spec in the suite for no extra information.
 */
test('a 300-page document opens, scrolls, and stays within its caps', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one measurement is enough')
  test.setTimeout(120_000)

  await page.goto('/')

  const openStart = Date.now()
  await page.setInputFiles('input[type=file]', LARGE)
  await expect(page.getByRole('img', { name: 'Page 1' })).toBeVisible({ timeout: 60_000 })
  const timeToFirstPage = Date.now() - openStart

  // Time to a usable editor: the page grid populated, not just one bitmap.
  const interactiveStart = Date.now()
  await expect(page.locator('[data-page-tile]').first()).toBeVisible({ timeout: 60_000 })
  const timeToInteractive = Date.now() - interactiveStart

  // Scroll through 50 pages, sampling how long each step takes to settle.
  const scroller = page.locator('[role="region"][aria-label="Document pages"]')
  const steps = 50
  const scrollStart = Date.now()
  for (let i = 0; i < steps; i++) {
    await scroller.evaluate((el) => { el.scrollTop += el.clientHeight })
    await page.waitForTimeout(16)
  }
  const scrollMs = Date.now() - scrollStart

  const memory = await page.evaluate(() => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    return m ? Math.round(m.usedJSHeapSize / (1024 * 1024)) : null
  })

  const pages = await page.locator('[data-page-tile]').count()

  // eslint-disable-next-line no-console
  console.log(`[perf] ${JSON.stringify({
    pages,
    timeToFirstPageMs: timeToFirstPage,
    timeToInteractiveMs: timeToInteractive,
    scrollMsFor50Pages: scrollMs,
    msPerScrollStep: Math.round(scrollMs / steps),
    heapMB: memory,
  })}`)

  expect(pages).toBe(300)
  // Loose bounds: these catch a real regression, not a slow machine.
  expect(timeToFirstPage).toBeLessThan(30_000)

  // Page 1 is GONE from the DOM after scrolling fifty pages away, which is
  // the virtualizer doing its job -- if it were still mounted, the list
  // would be growing without bound and the memory number above would mean
  // nothing.
  await expect(page.getByRole('img', { name: 'Page 1' })).toHaveCount(0)
  await expect(page.locator('[role="img"]').first()).toBeVisible()
})
