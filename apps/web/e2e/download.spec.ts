import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/simple-text.pdf', import.meta.url),
)

test('downloads an unedited document byte-for-byte', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('input[type=file]', FIXTURE)
  await expect(page.getByRole('img', { name: 'Page 1' })).toBeVisible()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download' }).click(),
  ])

  expect(download.suggestedFilename()).toBe('simple-text.pdf')
  const path = await download.path()
  expect(readFileSync(path!).equals(readFileSync(FIXTURE))).toBe(true)
})
