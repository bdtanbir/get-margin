import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FIXTURES = fileURLToPath(new URL('../../../packages/pdf-core/test/fixtures/', import.meta.url))
const HOSTILE = `${FIXTURES}hostile.pdf`
const CLEAN = `${FIXTURES}simple-text.pdf`

/**
 * The only test that exercises the whole path a hostile file actually
 * takes: opened in the real app, exported through the real worker, and the
 * downloaded bytes inspected.
 */
test('a downloaded file carries no script from a hostile original', async ({ page }) => {
  // The fixture has to be hostile for this to mean anything.
  expect(readFileSync(HOSTILE).includes('app.alert')).toBe(true)

  await page.goto('/')
  await page.setInputFiles('input[type=file]', HOSTILE)
  await expect(page.getByRole('img', { name: 'Page 1' })).toBeVisible()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download' }).click(),
  ])

  const bytes = readFileSync((await download.path())!)
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
  expect(bytes.includes('app.alert')).toBe(false)
  expect(bytes.includes('exportDataObject')).toBe(false)
})

test('the user is told what was removed', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('input[type=file]', HOSTILE)
  await expect(page.getByRole('img', { name: 'Page 1' })).toBeVisible()

  await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download' }).click(),
  ])

  await expect(page.locator('[data-stripped-notice]')).toContainText('Removed')
  await expect(page.locator('[data-stripped-notice]')).toContainText('form-field scripts')
})

test('a clean document downloads with no notice and unchanged bytes', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('input[type=file]', CLEAN)
  await expect(page.getByRole('img', { name: 'Page 1' })).toBeVisible()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download' }).click(),
  ])

  // Stripping must not have cost the byte-identity guarantee for clean files.
  expect(readFileSync((await download.path())!).equals(readFileSync(CLEAN))).toBe(true)
  await expect(page.locator('[data-stripped-notice]')).toHaveCount(0)
})
