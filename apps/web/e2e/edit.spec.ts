import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/simple-text.pdf', import.meta.url),
)

async function openFixture(page: Page): Promise<void> {
  await page.goto('/')
  await page.setInputFiles('input[type=file]', FIXTURE)
  await expect(page.getByRole('img', { name: 'Page 1' })).toBeVisible()
}

/** Drag out a shape on the first page's draw surface. */
async function drawOn(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const surface = page.locator('[data-draw-surface]').first()
  await expect(surface).toBeVisible()
  const box = (await surface.boundingBox())!
  await page.mouse.move(box.x + from.x, box.y + from.y)
  await page.mouse.down()
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 8 })
  await page.mouse.up()
}

const objectCount = (page: Page) => page.locator('[data-object-id]').count()

test.describe('editing', () => {
  // Uses the TOOLBAR buttons rather than the keyboard, so this runs on both
  // projects: useEditShortcuts is installed from DesktopShell only, because
  // the phone shell has no physical keyboard. The buttons are the reason
  // undo/redo is reachable there at all.
  test('draws a rectangle, undoes and redoes it', async ({ page }) => {
    await openFixture(page)

    await page.getByRole('button', { name: 'Rectangle' }).first().click()
    await drawOn(page, { x: 60, y: 80 }, { x: 200, y: 180 })
    await expect(page.locator('[data-object-id]')).toHaveCount(1)

    // The whole drag must be ONE undo step, not one per pointermove.
    await page.locator('[data-undo]').click()
    await expect(page.locator('[data-object-id]')).toHaveCount(0)

    await page.locator('[data-redo]').click()
    await expect(page.locator('[data-object-id]')).toHaveCount(1)
  })

  test('undoes from the keyboard on desktop', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'keyboard shortcuts are desktop-only')
    await openFixture(page)

    await page.getByRole('button', { name: 'Rectangle' }).first().click()
    await drawOn(page, { x: 60, y: 80 }, { x: 200, y: 180 })
    await expect(page.locator('[data-object-id]')).toHaveCount(1)

    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.locator('[data-object-id]')).toHaveCount(0)

    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(page.locator('[data-object-id]')).toHaveCount(1)
  })

  test('exports a document that reopens with the edit present', async ({ page }) => {
    await openFixture(page)

    await page.getByRole('button', { name: 'Rectangle' }).first().click()
    await drawOn(page, { x: 60, y: 80 }, { x: 200, y: 180 })
    await expect(page.locator('[data-object-id]')).toHaveCount(1)

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download' }).click(),
    ])

    const path = await download.path()
    const edited = readFileSync(path!)
    const original = readFileSync(FIXTURE)

    // An edited export must NOT be the original bytes -- that pass-through
    // is only correct for an unedited document (see download.spec.ts).
    expect(edited.equals(original)).toBe(false)
    expect(edited.subarray(0, 5).toString()).toBe('%PDF-')
    expect(edited.byteLength).toBeGreaterThan(0)
  })

  test('places text and keeps a typing burst to one undo step', async ({ page }) => {
    await openFixture(page)

    await page.getByRole('button', { name: 'Text' }).first().click()
    await drawOn(page, { x: 60, y: 240 }, { x: 260, y: 270 })

    const editor = page.locator('[data-text-editor]')
    await expect(editor).toBeVisible()
    await editor.pressSequentially('hello')
    await expect(editor).toHaveText('hello')

    // Commit the typing, then blur out of the editor.
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await expect(editor).toBeHidden()

    // One undo removes the typing; a second removes the empty frame. Via the
    // toolbar so this covers the phone shell too.
    await page.locator('[data-undo]').click()
    await page.locator('[data-undo]').click()
    await expect(page.locator('[data-object-id]')).toHaveCount(0)
  })

  test('never names the whiteout tool "redact"', async ({ page }) => {
    await openFixture(page)
    // Spec 2.1: the tool covers content and does not remove it; calling it
    // redaction is a real user-harm risk.
    await expect(page.getByRole('button', { name: 'Whiteout' }).first()).toBeVisible()
    expect((await page.content()).toLowerCase()).not.toContain('redact')
  })
})
