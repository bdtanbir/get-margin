import { test, expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/multi-page.pdf', import.meta.url),
)

/**
 * Every editing gesture on a phone competes with the scroller.
 *
 * PageList's scroll container declares `touch-action: pan-x pan-y`, so the
 * browser is entitled to treat any one-finger drag that starts inside it as
 * a pan. A drag that draws, moves, resizes or inks is NOT a pan, and while
 * the browser is deciding it scrolls the document under the finger and can
 * take the gesture away entirely with a `pointercancel`. That is what "it
 * adds, but not smooth" is.
 *
 * WHY THIS ASSERTS COMPUTED STYLE rather than dragging and measuring: the
 * browser's pan is native input handling, not something script can trigger.
 * Synthetic touch events dispatched from a test never scroll, so a
 * behavioural test here would pass just as happily with the bug present.
 * `touch-action` IS the contract -- it is the single declaration the
 * compositor reads to decide whether the gesture belongs to the page or to
 * us -- and its computed value is the only observable form it has. Deleting
 * the declaration is precisely the regression this catches.
 *
 * `none`, not `manipulation`: the effective value is the INTERSECTION down
 * the ancestor chain, and only `none` overrides the scroller's `pan-x
 * pan-y` completely.
 */
const PHONE_ONLY = 'phone only — this is about touch gesture arbitration'

async function openDocument(page: Page): Promise<void> {
  await page.goto('/')
  await page.setInputFiles('input[type=file]', FIXTURE)
  await expect(page.getByRole('img', { name: 'Page 1', exact: true }).locator('canvas'))
    .toBeVisible({ timeout: 30_000 })
}

/**
 * `.first()` throughout: one draw surface and one ink canvas are mounted
 * PER RENDERED PAGE, so a bare selector is ambiguous under strict mode.
 * They are rendered from one component with one class list, so checking the
 * first is checking all of them.
 */
const surface = (page: Page, selector: string) => page.locator(selector).first()

const touchAction = (page: Page, selector: string) =>
  surface(page, selector).evaluate((el) => getComputedStyle(el).touchAction)

test.describe('touch gestures belong to the editor, not the scroller', () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', PHONE_ONLY)
  })

  test('the draw surface does not hand a shape drag to the scroller', async ({ page }) => {
    await openDocument(page)

    await page.getByRole('button', { name: 'Arrow' }).click()

    await expect(surface(page, '[data-draw-surface]')).toBeAttached()
    expect(await touchAction(page, '[data-draw-surface]')).toBe('none')
  })

  test('the ink canvas does not hand a stroke to the scroller', async ({ page }) => {
    await openDocument(page)

    await page.getByRole('button', { name: 'Draw' }).click()

    await expect(surface(page, '[data-ink-canvas]')).toBeAttached()
    expect(await touchAction(page, '[data-ink-canvas]')).toBe('none')
  })

  test('a selected object does not hand its move drag to the scroller', async ({ page }) => {
    await openDocument(page)
    await page.getByRole('button', { name: 'Rectangle' }).click()

    // Drag out a rectangle, which leaves it selected and its chrome mounted.
    const box = (await surface(page, '[data-draw-surface]').boundingBox())!
    await page.mouse.move(box.x + 40, box.y + 60)
    await page.mouse.down()
    await page.mouse.move(box.x + 140, box.y + 160, { steps: 8 })
    await page.mouse.up()

    await expect(surface(page, '[data-selection]')).toBeVisible()
    expect(await touchAction(page, '[data-selection]')).toBe('none')
  })
})

/**
 * Drawing something should leave you looking at the thing you drew.
 *
 * The properties sheet used to be presence-driven off the selection, and a
 * newly drawn object is selected -- so half the page disappeared behind a
 * panel after every shape, and again the moment a finger landed on an
 * object to move it, since objects select on pointerdown. Properties are
 * now asked for explicitly.
 */
test.describe('properties are asked for, not volunteered', () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', PHONE_ONLY)
  })

  async function drawARectangle(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Rectangle' }).click()
    const box = (await surface(page, '[data-draw-surface]').boundingBox())!
    await page.mouse.move(box.x + 40, box.y + 60)
    await page.mouse.down()
    await page.mouse.move(box.x + 140, box.y + 160, { steps: 8 })
    await page.mouse.up()
  }

  test('drawing a shape does not cover the page with a properties sheet', async ({ page }) => {
    await openDocument(page)

    await drawARectangle(page)

    await expect(page.locator('[data-selection]')).toBeVisible()
    await expect(page.locator('[data-inspector-sheet]')).toBeHidden()
  })

  test('the properties button opens the sheet for the selected object', async ({ page }) => {
    await openDocument(page)
    await drawARectangle(page)

    await page.getByRole('button', { name: 'Properties' }).click()

    await expect(page.locator('[data-inspector-sheet]')).toBeVisible()
  })

  test('there is nothing to ask about with nothing selected', async ({ page }) => {
    await openDocument(page)

    await expect(page.getByRole('button', { name: 'Properties' })).toBeHidden()
  })

  test('dismissing the sheet keeps the object selected', async ({ page }) => {
    await openDocument(page)
    await drawARectangle(page)
    await page.getByRole('button', { name: 'Properties' }).click()
    await expect(page.locator('[data-inspector-sheet]')).toBeVisible()

    await page.locator('[data-inspector-done]').click()

    await expect(page.locator('[data-inspector-sheet]')).toBeHidden()
    await expect(page.locator('[data-selection]')).toBeVisible()
  })
})
