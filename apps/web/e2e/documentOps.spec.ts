import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/simple-text.pdf', import.meta.url),
)
const SIMPLE = FIXTURE
/** Different text from SIMPLE, so reading the wrong page is unmistakable. */
const MIXED = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/mixed-fonts.pdf', import.meta.url),
)

async function open(page: Page): Promise<void> {
  await page.goto('/')
  await page.setInputFiles('input[type=file]', FIXTURE)
  await expect(page.getByRole('img', { name: 'Page 1' })).toBeVisible()
}

/** Reach a document-wide dialog the way a user does, through the palette. */
async function command(page: Page, label: RegExp): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.locator('[data-command-palette]')).toBeVisible()
  await page.getByRole('option', { name: label }).first().click()
}

async function download(page: Page): Promise<Buffer> {
  const [event] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download' }).click(),
  ])
  return readFileSync((await event.path())!)
}

test('a watermark reaches the exported document', async ({ page }) => {
  await open(page)
  await command(page, /Watermark, page numbers/i)
  await expect(page.locator('[data-stamp-dialog]')).toBeVisible()

  await page.locator('[data-stamp-template]').fill('CONFIDENTIAL')
  await expect(page.locator('[data-stamp-preview]')).toContainText('CONFIDENTIAL')
  await page.locator('[data-stamp-apply]').click()
  await expect(page.locator('[data-stamp-dialog]')).toBeHidden()

  // Drawn as page content, so it survives into the file rather than being
  // an annotation a reader could delete.
  const bytes = await download(page)
  expect(bytes.equals(readFileSync(FIXTURE))).toBe(false)
  // And nothing failed silently on the way -- an export error used to be
  // set on a store nothing displayed.
  await expect(page.locator('[data-export-error]')).toBeHidden()
})

test('page numbers number the document, not the selection', async ({ page }) => {
  await open(page)
  await command(page, /Watermark, page numbers/i)
  await page.locator('[data-preset="footer"]').click()
  await expect(page.locator('[data-stamp-preview]')).toContainText('1 of 1')
  await page.locator('[data-stamp-apply]').click()
  await expect(page.locator('[data-stamp-dialog]')).toBeHidden()
})

test('document details are editable and removable', async ({ page }) => {
  await open(page)
  await command(page, /Document details/i)
  await expect(page.locator('[data-metadata-dialog]')).toBeVisible()

  await page.locator('[data-metadata-field="title"]').fill('A New Title')
  await page.locator('[data-metadata-apply]').click()
  await expect(page.locator('[data-metadata-dialog]')).toBeHidden()

  const bytes = await download(page)
  // /Info is written uncompressed, so the title is findable in the bytes.
  expect(bytes.includes('A New Title')).toBe(true)
})

test('removing all details says what it costs', async ({ page }) => {
  await open(page)
  await command(page, /Document details/i)
  await expect(page.locator('[data-metadata-dialog]'))
    .toContainText(/creation date and its identifier/i)
  await page.locator('[data-metadata-strip]').click()
  await expect(page.locator('[data-metadata-dialog]')).toBeHidden()

  const bytes = await download(page)
  expect(bytes.includes('get-margin-fixtures')).toBe(false)
})

/**
 * The claim this feature is sold on, checked through the UI: the text is
 * not in the file afterwards. pdf-core verifies it with two independent
 * extractors; this checks the user's path reaches that code at all.
 */
test('redacted text is absent from the exported bytes', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Redact' }).first().click()

  // Select the first line by dragging across it.
  const canvas = page.getByRole('img', { name: 'Page 1' })
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.13)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.13)
  await page.mouse.up()

  await expect(page.locator('[data-redact]')).toBeVisible()
  await page.locator('[data-redact]').click()

  const bytes = await download(page)
  expect(bytes.includes('Hello margin')).toBe(false)
})

test('the protect dialog states which half is enforced', async ({ page }) => {
  await open(page)
  await command(page, /Protect with a password/i)
  await expect(page.locator('[data-protect-dialog]')).toBeVisible()

  const caveat = page.locator('[data-protect-caveat]')
  await expect(caveat).toContainText(/real encryption/i)
  await expect(caveat).toContainText(/request to the PDF reader/i)

  // Mismatched confirmation refuses.
  await page.locator('[data-protect-password]').fill('hunter2')
  await page.locator('[data-protect-confirm]').fill('hunter3')
  await expect(page.locator('[data-protect-mismatch]')).toBeVisible()
  await expect(page.locator('[data-protect-apply]')).toBeDisabled()
})

test('a protected download actually demands its password', async ({ page }) => {
  await open(page)
  await command(page, /Protect with a password/i)
  await page.locator('[data-protect-password]').fill('hunter2')
  await page.locator('[data-protect-confirm]').fill('hunter2')

  const [event] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-protect-apply]').click(),
  ])
  const bytes = readFileSync((await event.path())!)
  // protectedSave reopens its own output and asserts needsPassword before
  // returning, so a file arriving here at all is the assertion passing --
  // and the encryption dictionary is the visible trace of it.
  expect(bytes.includes('Encrypt')).toBe(true)
  expect(bytes.equals(readFileSync(FIXTURE))).toBe(false)
})

test('find reports matches and steps through them', async ({ page }) => {
  await open(page)
  await command(page, /Find in document/i)
  await expect(page.locator('[data-find-panel]')).toBeVisible()

  await page.locator('[data-find-input]').fill('line')
  await expect(page.locator('[data-find-count]')).toContainText(/of/i)
  await expect(page.locator('[data-find-highlights]').first()).toBeVisible()
})

test('find says so plainly when nothing matches', async ({ page }) => {
  await open(page)
  await command(page, /Find in document/i)
  await page.locator('[data-find-input]').fill('zzzznotpresent')
  await expect(page.locator('[data-find-count]')).toContainText('No matches')
})

test('compression measures before offering a download', async ({ page }) => {
  await open(page)
  await command(page, /Make the file smaller/i)
  await expect(page.locator('[data-compress-dialog]')).toBeVisible()

  // Nothing to download until it has been measured.
  await expect(page.locator('[data-compress-download]')).toBeHidden()
  await page.locator('[data-compress-estimate]').click()
  await expect(page.locator('[data-compress-result]')).toBeVisible()

  /**
   * The fixture has no photographs, so the saving comes from structure
   * alone and the dialog says so. Which of the two outcomes applies
   * depends on the file -- simple-text happens to re-serialise smaller --
   * so this asserts the honest reporting rather than a specific verdict.
   */
  await expect(page.locator('[data-compress-result]'))
    .toContainText(/No photographs were found|already as small/i)
  await expect(page.locator('[data-compress-download]')).toBeVisible()
})

/**
 * Each page's text tool must read THAT page's text.
 *
 * On a merged document it read the wrong file entirely: `quadIndex` looked
 * the page up in the primary document however it was asked, and the overlay
 * passed only `sourceIndex` -- which is 0 for the first page of every file.
 * So clicking a line on page two opened an editor containing a line from
 * page one, and committing would have covered the wrong text.
 * See `docs/findings/24-merged-text-index.md`.
 */
test('the text tool reads each page of a merged document', async ({ page }, testInfo) => {
  // The add-source control lives inside the pages modal on phone, and this
  // defect is worker lookup logic rather than anything engine-specific.
  test.skip(testInfo.project.name === 'phone', 'add-source is behind the pages modal on phone')

  await page.goto('/')
  await page.setInputFiles('input[type=file]', SIMPLE)
  await expect(page.getByRole('img', { name: 'Page 1', exact: true })).toBeVisible({
    timeout: 30_000,
  })
  await page.locator('input[type=file]').nth(1).setInputFiles(MIXED)
  await expect(page.locator('[data-source-header]')).toHaveCount(2)

  await page.getByRole('button', { name: 'Edit text' }).first().click()
  await page.getByRole('option', { name: /^Page 2/ }).click()
  await page.waitForTimeout(1200)

  // The two pages carry different text, so a page reading the other one's
  // index is unmistakable rather than merely suspicious.
  const layers = page.locator('[data-patch-layer]')
  await expect(layers).toHaveCount(2)

  const secondPage = layers.nth(1).locator('[data-patch-target]')
  await expect(secondPage.first()).toBeVisible()
  await secondPage.first().click()

  const opened = await page.locator('[data-patch-input]').inputValue()
  expect(opened, 'page 2 opened with page 1 text').toContain('Helvetica')
  expect(opened).not.toContain('Hello margin')
})

/**
 * The viewer has to show the edit, not just the exported file.
 *
 * The test below this one asserts the EXPORT changes, and passed for
 * months while the viewer showed the original text and gave no sign
 * anything had happened -- `ObjectLayer` had no renderer registered for
 * `textPatch`, and an unregistered kind renders nothing. An editor whose
 * edits are only visible after downloading is not an editor.
 */
test('editing a line shows the replacement in the viewer', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Edit text' }).first().click()

  const target = page.locator('[data-patch-target]').first()
  await expect(target).toBeVisible()
  await target.click()

  await page.locator('[data-patch-input]').fill('Replaced by a test')
  // Enter commits; there is no Replace button any more. Clicking away
  // commits too -- see PatchEditor.
  await page.locator('[data-patch-input]').press('Enter')

  // The page itself is a canvas, so the only DOM text on the page is what
  // the overlay drew.
  const drawn = page.locator('svg text', { hasText: 'Replaced by a test' })
  await expect(drawn).toHaveCount(1)
  await expect(drawn).toBeVisible()
})

test('editing a line replaces it in the export', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Edit text' }).first().click()

  const target = page.locator('[data-patch-target]').first()
  await expect(target).toBeVisible()
  await target.click()

  await page.locator('[data-patch-input]').fill('Replaced by a test')
  await page.locator('[data-patch-input]').press('Enter')

  const bytes = await download(page)
  expect(bytes.equals(readFileSync(FIXTURE))).toBe(false)
})
