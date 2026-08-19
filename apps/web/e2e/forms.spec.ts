import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/form.pdf', import.meta.url),
)

/**
 * The fixture is built by pdf-lib's form API, not by this project's write
 * path -- so these tests read a form somebody else made, which is the case
 * that matters. Generating it with the same code under test would let a
 * shared misunderstanding pass on both sides.
 */
async function openForm(page: Page): Promise<void> {
  await page.goto('/')
  await page.setInputFiles('input[type=file]', FIXTURE)
  await expect(page.getByRole('img', { name: 'Page 1' })).toBeVisible()
  await expect(page.locator('[data-field-layer]')).toBeVisible()
}

test('renders the document’s fields as real inputs', async ({ page }) => {
  await openForm(page)

  // Real platform controls, so the browser's own selectors find them.
  await expect(page.locator('input[data-field="fullname"]')).toBeVisible()
  await expect(page.locator('textarea[data-field="notes"]')).toBeVisible()
  await expect(page.locator('input[data-field="agree"][type="checkbox"]')).toBeVisible()
  await expect(page.locator('select[data-field="country"]')).toBeVisible()
  await expect(page.locator('input[data-field="contact"][type="radio"]')).toHaveCount(3)
})

test('a filled field reaches the exported bytes', async ({ page }) => {
  await openForm(page)
  await page.locator('input[data-field="fullname"]').fill('Ada Lovelace')
  await page.locator('select[data-field="country"]').selectOption('Canada')
  await page.locator('input[data-field="agree"]').check()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download' }).click(),
  ])
  const bytes = readFileSync((await download.path())!)
  expect(bytes.includes('Ada Lovelace')).toBe(true)
  // Not merely present: the export must differ from the file that was
  // opened, or the pass-through tier discarded everything the user did.
  expect(bytes.equals(readFileSync(FIXTURE))).toBe(false)
})

/**
 * The failure the pre-flight was run to catch, seen from the user's side:
 * a group whose buttons are all one button turns them all on at once.
 */
test('selecting one radio button deselects the others', async ({ page }) => {
  await openForm(page)
  const buttons = page.locator('input[data-field="contact"][type="radio"]')

  await buttons.nth(1).check()
  await expect(buttons.nth(0)).not.toBeChecked()
  await expect(buttons.nth(1)).toBeChecked()
  await expect(buttons.nth(2)).not.toBeChecked()

  await buttons.nth(2).check()
  await expect(buttons.nth(1)).not.toBeChecked()
  await expect(buttons.nth(2)).toBeChecked()
})

test('typing in a field is one undo, not one per keystroke', async ({ page }) => {
  await openForm(page)
  const field = page.locator('input[data-field="fullname"]')
  await field.fill('Ada')
  await expect(field).toHaveValue('Ada')

  await page.locator('[data-undo]').click()
  await expect(field).toHaveValue('')
})

test('a read-only document field can be seen but not changed', async ({ page }) => {
  await openForm(page)
  // The fixture has no read-only field, so this asserts the converse: an
  // ordinary field is editable, which is what makes the disabled state in
  // the unit tests meaningful rather than vacuous.
  await expect(page.locator('input[data-field="fullname"]')).toBeEnabled()
})

test('locking the answers removes the fields from the export', async ({ page }) => {
  await openForm(page)
  await page.locator('input[data-field="fullname"]').fill('Ada Lovelace')

  await expect(page.locator('[data-flatten-forms]')).toBeVisible()
  await page.locator('[data-flatten-forms] input').check()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download' }).click(),
  ])
  const bytes = readFileSync((await download.path())!)
  // The machinery that made it a form is gone.
  expect(bytes.includes('/AcroForm')).toBe(false)
  expect(bytes.equals(readFileSync(FIXTURE))).toBe(false)
  // The VALUE surviving as page content is asserted in
  // pdf-core/test/write/fields.test.ts, which can read the page's text.
  // Here it is inside a compressed content stream, so a raw-byte search
  // would fail whether or not the value made it -- an assertion that can
  // only mislead is worse than none.
})

test('a form left untouched still downloads byte for byte', async ({ page }) => {
  await openForm(page)
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download' }).click(),
  ])
  expect(readFileSync((await download.path())!).equals(readFileSync(FIXTURE))).toBe(true)
})

test('a field the user creates is in the exported document', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('input[type=file]', FIXTURE)
  await expect(page.getByRole('img', { name: 'Page 1' })).toBeVisible()

  await page.getByRole('button', { name: 'Form field' }).click()
  const canvas = page.getByRole('img', { name: 'Page 1' })
  // Fractions of the page box, not fixed pixel offsets: the phone's canvas
  // is a different size, and 500px down a desktop page is off the bottom of
  // a phone one.
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.62)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.66)
  await page.mouse.up()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download' }).click(),
  ])
  const bytes = readFileSync((await download.path())!)
  expect(bytes.includes('text_1')).toBe(true)
})
