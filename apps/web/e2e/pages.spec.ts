import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FIXTURES = fileURLToPath(new URL('../../../packages/pdf-core/test/fixtures/', import.meta.url))
const MULTI = `${FIXTURES}multi-page.pdf`
const SIMPLE = `${FIXTURES}simple-text.pdf`

async function open(page: Page, file = MULTI): Promise<void> {
  await page.goto('/')
  await page.setInputFiles('input[type=file]', file)
  await expect(page.getByRole('img', { name: 'Page 1' })).toBeVisible()
}

/** The pages panel is a sidebar on desktop and a modal on phone. */
async function openPages(page: Page, testInfo: { project: { name: string } }): Promise<void> {
  if (testInfo.project.name === 'phone') {
    await page.getByRole('button', { name: 'Pages' }).click()
  }
  await expect(page.locator('[data-page-tile]').first()).toBeVisible()
}

/**
 * Selection-based page actions are DESKTOP ONLY for now.
 *
 * On the phone shell the pages panel is a full-screen modal that closes
 * when a thumbnail is tapped -- deliberate Phase 1 behaviour, so that
 * tapping a page navigates to it rather than jumping the viewport behind a
 * still-open overlay. That makes tap-to-select unreachable there: the grid
 * carrying the rotate and delete controls is gone by the time the selection
 * exists.
 *
 * Fixing it properly needs a touch-specific affordance (a per-tile select
 * control, or a select mode), which PHASE-3-DESIGN.md 6 called for and this
 * phase did not build. Recorded as outstanding in
 * docs/findings/08-phase-3-verification.md rather than papered over with a
 * gesture invented at test-writing time.
 */
const desktopOnly = (testInfo: { project: { name: string } }): void => {
  test.skip(testInfo.project.name !== 'desktop', 'page selection is desktop-only; see the note above')
}

const tiles = (page: Page) => page.locator('[data-page-tile]')

test.describe('page operations', () => {
  test('deletes a selected page and undoes it', async ({ page }, testInfo) => {
    desktopOnly(testInfo)
    await open(page)
    await openPages(page, testInfo)
    const before = await tiles(page).count()

    await tiles(page).nth(1).click()
    await page.locator('[data-delete-pages]').click()
    await expect(tiles(page)).toHaveCount(before - 1)

    // Page ops share the object ops' undo stack, so the toolbar's Undo
    // reaches them.
    await page.locator('[data-undo]').click()
    await expect(tiles(page)).toHaveCount(before)
  })

  test('rotates a selected page', async ({ page }, testInfo) => {
    desktopOnly(testInfo)
    await open(page)
    await openPages(page, testInfo)
    const first = page.getByRole('img', { name: 'Page 1' })
    const before = await first.boundingBox()

    await tiles(page).nth(0).click()
    await page.locator('[data-rotate-right]').click()

    // A quarter turn swaps the rendered page's aspect ratio.
    await expect
      .poll(async () => {
        const box = await first.boundingBox()
        return box ? box.width > box.height : false
      })
      .toBe(true)
    expect(before!.width).toBeLessThan(before!.height)
  })

  test('exports the edited page set, and it reopens with the right count', async ({ page }, testInfo) => {
    desktopOnly(testInfo)
    await open(page)
    await openPages(page, testInfo)
    const before = await tiles(page).count()

    await tiles(page).nth(0).click()
    await page.locator('[data-delete-pages]').click()
    await expect(tiles(page)).toHaveCount(before - 1)

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download' }).click(),
    ])
    const bytes = readFileSync((await download.path())!)
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    // A deleted page means the export is not the original file.
    expect(bytes.equals(readFileSync(MULTI))).toBe(false)
  })

  test('merges a second document and spans both in the grid', async ({ page }, testInfo) => {
    await open(page)
    await openPages(page, testInfo)
    const before = await tiles(page).count()

    // The add-source input is the second file input on the page.
    await page.locator('input[type=file]').nth(1).setInputFiles(SIMPLE)
    await expect(tiles(page)).toHaveCount(before + 1)

    // Two sources means the grid labels where each file's pages begin, and
    // says what a merge does not carry over.
    await expect(page.locator('[data-source-header]')).toHaveCount(2)
    await expect(page.locator('[data-merge-notice]')).toContainText('Bookmarks')
  })

  test('splits into a zip', async ({ page }, testInfo) => {
    await open(page)
    await openPages(page, testInfo)

    await page.locator('[data-open-split]').click()
    await page.locator('[data-split-input]').fill('1-2, 3-4')
    await expect(page.locator('[data-split-summary]')).toContainText('2 files')

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-split-run]').click(),
    ])
    expect(download.suggestedFilename()).toBe('multi-page-split.zip')
  })

  test('says cropping hides rather than removes', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Crop' }).first().click()
    await expect(page.locator('[data-crop-notice]')).toContainText('still in the file')
  })
})
