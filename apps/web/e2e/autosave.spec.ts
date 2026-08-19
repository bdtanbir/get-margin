import { test, expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/simple-text.pdf', import.meta.url),
)

async function open(page: Page): Promise<void> {
  await page.setInputFiles('input[type=file]', FIXTURE)
  await expect(page.getByRole('img', { name: 'Page 1' })).toBeVisible()
}

async function drawRectangle(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Rectangle' }).first().click()
  const surface = page.locator('[data-draw-surface]').first()
  const box = (await surface.boundingBox())!
  await page.mouse.move(box.x + 60, box.y + 80)
  await page.mouse.down()
  await page.mouse.move(box.x + 200, box.y + 180, { steps: 8 })
  await page.mouse.up()
  await expect(page.locator('[data-object-id]')).toHaveCount(1)
}

/**
 * The test that proves the feature. The unit tests only prove the parts:
 * this is the one that shows an edit surviving the tab going away.
 */
test('edits survive a reload and are offered back', async ({ page }) => {
  await page.goto('/')
  await open(page)
  await drawRectangle(page)

  // Wait for the SIGNAL, not a duration: a fixed sleep races the debounce
  // and the IndexedDB commit, which made this spec flaky before.
  await expect(page.locator('[data-autosave-state="saved"]')).toBeVisible()

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Open a PDF' })).toBeVisible()
  await open(page)

  // OFFERED, not applied: the document comes back clean until accepted.
  const prompt = page.locator('[data-restore-prompt]')
  await expect(prompt).toBeVisible()
  await expect(page.locator('[data-object-id]')).toHaveCount(0)

  await page.locator('[data-restore-accept]').click()
  await expect(page.locator('[data-object-id]')).toHaveCount(1)
  await expect(prompt).toBeHidden()
})

test('declining leaves a clean document and does not ask again', async ({ page }) => {
  await page.goto('/')
  await open(page)
  await drawRectangle(page)
  await expect(page.locator('[data-autosave-state="saved"]')).toBeVisible()

  await page.reload()
  await open(page)
  await page.locator('[data-restore-discard]').click()
  await expect(page.locator('[data-object-id]')).toHaveCount(0)

  // Discarded for good: reopening the same file offers nothing.
  await page.reload()
  await open(page)
  await expect(page.locator('[data-restore-prompt]')).toHaveCount(0)
})

test('a file with no stored edits is not offered a restore', async ({ page }) => {
  await page.goto('/')
  await open(page)
  await expect(page.locator('[data-restore-prompt]')).toHaveCount(0)
})
