import { test, expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/multi-page.pdf', import.meta.url),
)

/**
 * Clicking a page in the sidebar must take you to that page.
 *
 * This is the behaviour a PDF reader is expected to have, and it was broken
 * in two compounding ways -- see `docs/findings/22-page-navigation.md`. The
 * assertions below are about what is ON SCREEN, not about internal state,
 * because "the anchor says 3" and "the user is looking at page 3" had
 * drifted apart and only the second one matters.
 */

/**
 * The page the viewer is on: whichever fills most of the viewport.
 *
 * Not "the topmost visible page", which is wrong at the end of a document.
 * Scrolling is clamped at the bottom, so asking for the LAST page cannot
 * put it at the top when there is no screenful below it -- the previous
 * page's tail stays on screen above it, and every PDF reader behaves this
 * way. On a short viewport that made a correct navigation look like an
 * off-by-one. Largest visible area is what "the page you are looking at"
 * actually means, and it holds at both ends of the document.
 */
async function pageOnScreen(page: Page): Promise<number> {
  return page.evaluate(() => {
    let best = -1
    let bestArea = 0
    document.querySelectorAll('[role="img"][aria-label^="Page "]').forEach((el) => {
      const r = el.getBoundingClientRect()
      const visible = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0))
      if (visible > bestArea) {
        bestArea = visible
        best = Number(el.getAttribute('aria-label')!.replace('Page ', ''))
      }
    })
    return best
  })
}

/** The page the app believes is current, read from the tile's aria-current. */
async function currentPage(page: Page): Promise<number> {
  return page.evaluate(() => {
    const tiles = [...document.querySelectorAll('[data-page-tile]')]
    return tiles.findIndex((t) => t.getAttribute('aria-current') === 'true') + 1
  })
}

async function open(page: Page, testInfo: { project: { name: string } }): Promise<void> {
  await page.goto('/')
  await page.setInputFiles('input[type=file]', FIXTURE)
  await expect(page.getByRole('img', { name: 'Page 1', exact: true })).toBeVisible({
    timeout: 30_000,
  })
  if (testInfo.project.name === 'phone') {
    await page.getByRole('button', { name: 'Pages' }).click()
    await expect(page.getByRole('dialog', { name: 'Pages' })).toBeVisible()
  }
}

/** Click a thumbnail. On phone the modal closes on select, so reopen it. */
async function goToPage(page: Page, n: number, projectName: string): Promise<void> {
  await page.getByRole('option', { name: `Page ${n}`, exact: true }).click()
  if (projectName === 'phone') {
    await expect(page.getByRole('dialog', { name: 'Pages' })).toBeHidden()
    await page.getByRole('button', { name: 'Pages' }).click()
  }
  await page.waitForTimeout(400)
}

test.describe('page navigation from the sidebar', () => {
  /**
   * Opening a document must not move the viewport.
   *
   * It did: the anchor was derived from the middle of the virtualiser's
   * item array rather than from the scroll position, so a freshly opened
   * document immediately scrolled itself to page 3.
   */
  test('a freshly opened document is on page 1', async ({ page }, testInfo) => {
    await open(page, testInfo)
    await page.waitForTimeout(500)

    expect(await pageOnScreen(page)).toBe(1)
    expect(await currentPage(page)).toBe(1)
  })

  test('clicking a page scrolls to that page', async ({ page }, testInfo) => {
    await open(page, testInfo)

    for (const target of [5, 12, 1, 8]) {
      await goToPage(page, target, testInfo.project.name)
      expect(await pageOnScreen(page), `after clicking page ${target}`).toBe(target)
      expect(await currentPage(page), `after clicking page ${target}`).toBe(target)
    }
  })

  /**
   * The case `align: 'auto'` used to swallow.
   *
   * Clicking the NEXT page, which is already partly visible below the
   * current one, did nothing at all -- the viewer decided it was close
   * enough and stayed where it was.
   */
  test('clicking an adjacent, partly visible page still goes to it', async ({ page }, testInfo) => {
    await open(page, testInfo)
    await goToPage(page, 4, testInfo.project.name)
    expect(await pageOnScreen(page)).toBe(4)

    await goToPage(page, 5, testInfo.project.name)
    expect(await pageOnScreen(page)).toBe(5)
  })

  /** Scrolling by hand must still update which page is shown as current. */
  test('scrolling updates the current page without being fought', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'wheel scrolling is a desktop interaction')
    await open(page, testInfo)

    await page.mouse.move(1000, 500)
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 400)
    await page.waitForTimeout(700)

    const shown = await pageOnScreen(page)
    expect(shown).toBeGreaterThan(1)
    // The current-page marker follows the scroll rather than snapping back.
    expect(await currentPage(page)).toBe(shown)
  })
})
