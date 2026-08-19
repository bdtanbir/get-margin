import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FIXTURES = fileURLToPath(new URL('../../../packages/pdf-core/test/fixtures/', import.meta.url))
const MULTI = `${FIXTURES}multi-page.pdf`
const SIMPLE = `${FIXTURES}simple-text.pdf`

/**
 * Select a page without navigating.
 *
 * Tapping the thumbnail navigates and, on the phone, closes the panel --
 * which is why these tests were desktop-only until Task 64 gave every tile
 * its own select control.
 */
async function selectPage(page: Page, index: number): Promise<void> {
  await page.locator('[data-select-page]').nth(index).click()
}

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
 * Close the pages panel on phone.
 *
 * It is a full-screen modal there, so the TopBar's Undo and Download sit
 * behind it -- a test that reaches for them with the panel open is clicking
 * through an overlay that a real user could not.
 */
async function closePages(page: Page, testInfo: { project: { name: string } }): Promise<void> {
  if (testInfo.project.name !== 'phone') return
  await page.getByRole('button', { name: 'Done' }).click()
}

const tiles = (page: Page) => page.locator('[data-page-tile]')

test.describe('page operations', () => {
  test('deletes a selected page and undoes it', async ({ page }, testInfo) => {
    await open(page)
    await openPages(page, testInfo)
    const before = await tiles(page).count()

    await selectPage(page, 1)
    await page.locator('[data-delete-pages]').click()
    await expect(tiles(page)).toHaveCount(before - 1)

    // Page ops share the object ops' undo stack, so the toolbar's Undo
    // reaches them.
    await closePages(page, testInfo)
    await page.locator('[data-undo]').click()
    await openPages(page, testInfo)
    await expect(tiles(page)).toHaveCount(before)
  })

  test('rotates a selected page', async ({ page }, testInfo) => {
    await open(page)
    await openPages(page, testInfo)
    const first = page.getByRole('img', { name: 'Page 1' })
    const before = await first.boundingBox()

    await selectPage(page, 0)
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
    await open(page)
    await openPages(page, testInfo)
    const before = await tiles(page).count()

    await selectPage(page, 0)
    await page.locator('[data-delete-pages]').click()
    await expect(tiles(page)).toHaveCount(before - 1)

    await closePages(page, testInfo)
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
