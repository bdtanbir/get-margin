import { test, expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/multi-page.pdf', import.meta.url),
)

const page1 = (page: Page) =>
  page.getByRole('img', { name: 'Page 1', exact: true }).locator('canvas')

const scrollerOf = (page: Page) => page.getByRole('region', { name: 'Document pages' })

async function openZoomedIn(page: Page): Promise<void> {
  await page.goto('/')
  await page.setInputFiles('input[type=file]', FIXTURE)
  await expect(page1(page)).toBeVisible({ timeout: 30_000 })

  // Past fit, so the page is wider than the scroller and the horizontal
  // axis actually means something. ZOOM_STEPS tops out well above this.
  for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Zoom in' }).click()
  await expect(page1(page)).toBeVisible()
}

/**
 * A page wider than its scroller must be reachable at BOTH edges.
 *
 * Centring an overflowing box is the classic way to lose one of them:
 * `justify-content: center` distributes the overflow evenly, and the half
 * that lands before the scroll origin cannot be reached, because
 * `scrollLeft` has no negative side. The right half scrolls fine, so the
 * scrollbar looks healthy and only the left of the document is missing.
 */
test.describe('a zoomed-in page is reachable at both edges', () => {
  test('the left edge is not cut off when scrolled fully left', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'covered by the desktop projects')
    await openZoomedIn(page)

    const scroller = scrollerOf(page)
    await scroller.evaluate((el) => { el.scrollLeft = 0 })

    const pageBox = (await page1(page).boundingBox())!
    const viewBox = (await scroller.boundingBox())!

    // Scrolled hard left, nothing of the page may sit before the viewport.
    expect(
      Math.round(pageBox.x - viewBox.x),
      'the left of the page is off-screen with scrollLeft already at 0',
    ).toBeGreaterThanOrEqual(0)
  })

  test('the right edge is still reachable by scrolling', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'covered by the desktop projects')
    await openZoomedIn(page)

    const scroller = scrollerOf(page)
    await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth })

    const pageBox = (await page1(page).boundingBox())!
    const viewBox = (await scroller.boundingBox())!

    expect(
      Math.round(pageBox.x + pageBox.width - (viewBox.x + viewBox.width)),
      'the right of the page cannot be scrolled to',
    ).toBeLessThanOrEqual(0)
  })
})
