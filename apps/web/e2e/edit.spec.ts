import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/simple-text.pdf', import.meta.url),
)

/** A page with a real embedded image on it, at page-space y 200..300. */
const WITH_IMAGE = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/with-image.pdf', import.meta.url),
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
    // Spec 2.1: whiteout covers content and does not remove it, so calling
    // it redaction is a real user-harm risk.
    //
    // NARROWED in Phase 6, when a tool that genuinely removes text shipped.
    // The original form banned the word from the whole page, which was
    // right while nothing could legitimately carry it. Now exactly one
    // control may, and the claim that matters is the narrower one: the
    // control named Whiteout is not the control named Redact.
    await expect(page.getByRole('button', { name: 'Whiteout' }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Redact' }).first()).toBeVisible()

    const named = await page.getByRole('button').evaluateAll((buttons) =>
      buttons
        .map((b) => (b.getAttribute('aria-label') ?? '').toLowerCase())
        .filter((label) => label.includes('redact')),
    )
    expect(named).toEqual(['redact'])
  })
})

/**
 * A text object being edited must be drawn ONCE.
 *
 * `TextEditor` puts a real contenteditable in the DOM over the object,
 * while `ObjectLayer` draws the same object as SVG. Both were up at the
 * same time, so the string appeared twice a couple of pixels apart --
 * reported as "double text like shadow", and it vanished as soon as the
 * editor closed, which is what made it look like a rendering glitch rather
 * than two real elements.
 *
 * Asserted in a browser rather than in jsdom because it is a question about
 * what is on screen, and because the companion defect -- the selection box
 * swallowing the double-click that reopens the editor -- is a stacking
 * problem jsdom has no layout to reproduce.
 */
test('text being edited is drawn once, and can be reopened', async ({ page }) => {
  await openFixture(page)
  await page.getByRole('button', { name: 'Text' }).first().click()

  // Captured while the Text tool is still active: the draw surface only
  // exists for a drawing tool, and creating the frame switches back to
  // select, so asking for its box afterwards waits forever.
  const surface = page.locator('[data-draw-surface]').first()
  await expect(surface).toBeVisible()
  const box = (await surface.boundingBox())!

  // The same frame the test above draws, so this works on the phone
  // viewport too.
  await drawOn(page, { x: 60, y: 240 }, { x: 260, y: 270 })

  const editor = page.locator('[data-text-editor]')
  await expect(editor).toBeVisible()
  await editor.pressSequentially('Simple')
  await expect(editor).toHaveText('Simple')

  const drawn = async () =>
    page.evaluate(() => ({
      svg: [...document.querySelectorAll('svg text')].filter((e) =>
        e.textContent?.includes('Simple'),
      ).length,
      dom: [...document.querySelectorAll('[data-text-editor]')].filter((e) =>
        e.textContent?.includes('Simple'),
      ).length,
    }))

  // While editing: the contenteditable only. Two renderings is the shadow.
  expect(await drawn()).toEqual({ svg: 0, dom: 1 })

  // After finishing: the SVG only.
  await page.mouse.click(box.x + 300, box.y + 120)
  await expect(editor).toHaveCount(0)
  expect(await drawn()).toEqual({ svg: 1, dom: 0 })

  // And it can be edited again. The selection box covers the object, so this
  // double-click lands on that box rather than on the glyphs -- the case
  // that used to do nothing at all.
  await page.mouse.dblclick(box.x + 100, box.y + 255)
  await expect(editor).toHaveCount(1)
})


/**
 * "Click somewhere else to deselect."
 *
 * Reported against the Layers panel: picking a layer there opened its
 * properties and nothing on the document put them away again -- clicking
 * blank page left the object selected with its inspector open, and the only
 * exits were the panel's own back arrow or switching tools.
 *
 * A browser test, not jsdom: the claim is about which element a real click
 * at a real coordinate lands on, and the point of the fix is that a pointer
 * on blank page misses every selection surface and falls through to the
 * scroller underneath them all.
 */
test('a click on blank page deselects', async ({ page }) => {
  await openFixture(page)
  await page.getByRole('button', { name: 'Rectangle' }).first().click()

  // Captured while the draw surface still exists: drawing switches back to
  // the select tool, which unmounts it.
  const surface = page.locator('[data-draw-surface]').first()
  await expect(surface).toBeVisible()
  const box = (await surface.boundingBox())!

  await drawOn(page, { x: 40, y: 40 }, { x: 140, y: 90 })
  await expect(page.locator('[data-selection]')).toHaveCount(1)

  // Blank page, well clear of the shape.
  await page.mouse.click(box.x + 40, box.y + 400)
  await expect(page.locator('[data-selection]')).toHaveCount(0)
})

test('a click on blank page deselects a layer picked in the panel', async ({ page }, testInfo) => {
  // The route the defect was reported through. Desktop only because the
  // phone shell keeps layers behind a sheet rather than in a sidebar; the
  // rule itself is covered on every project by the test above.
  test.skip(testInfo.project.name !== 'desktop', 'the Layers sidebar is desktop-only')
  await openFixture(page)
  await page.getByRole('button', { name: 'Rectangle' }).first().click()

  const surface = page.locator('[data-draw-surface]').first()
  await expect(surface).toBeVisible()
  const box = (await surface.boundingBox())!
  await drawOn(page, { x: 40, y: 40 }, { x: 140, y: 90 })

  // Put away what drawing selected, so the panel row below is what selects
  // it -- otherwise this proves nothing about the panel.
  await page.mouse.click(box.x + 40, box.y + 400)
  await expect(page.locator('[data-selection]')).toHaveCount(0)

  await page.locator('[data-layer-row]').first().click()
  await expect(page.locator('[data-selection]')).toHaveCount(1)

  await page.mouse.click(box.x + 40, box.y + 400)
  await expect(page.locator('[data-selection]')).toHaveCount(0)
})

/**
 * Double-click the document's own text and you are editing it.
 *
 * The shortcut past the tool rail: people who have used any editor expect a
 * double-click on a word to put a caret in it, and until this existed the
 * only route to the document's own text was finding "Edit text" in a rail
 * of twenty tools.
 *
 * A browser test rather than jsdom, and not by preference: the hit test
 * converts client coordinates through `getScreenCTM()`, which jsdom does
 * not implement, so the question "does a real double-click at a real
 * coordinate open the right line" can only be asked where there is layout.
 * The DECISION -- which line is under a point -- is unit-tested in
 * editTargets.test.ts.
 */
test('double-clicking the document’s own text opens it for editing', async ({ page }) => {
  await openFixture(page)

  // Where a real line is, asked of the tool that draws targets over them,
  // then the document is handed back to the select tool so the double-click
  // is the thing under test rather than a click on a target.
  await page.getByRole('button', { name: 'Edit text' }).first().click()
  const target = page.locator('[data-patch-target]').first()
  await expect(target).toBeVisible()
  const box = (await target.boundingBox())!
  await page.getByRole('button', { name: 'Select', exact: true }).first().click()
  await expect(page.locator('[data-patch-target]')).toHaveCount(0)

  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)

  const input = page.locator('[data-patch-input]')
  await expect(input).toBeVisible()
  // The line's own words, ready to be replaced by typing.
  expect(await input.inputValue()).not.toBe('')
})

test('double-clicking blank page opens nothing', async ({ page }) => {
  await openFixture(page)
  const canvas = page.getByRole('img', { name: 'Page 1', exact: true }).first()
  const box = (await canvas.boundingBox())!

  // Well below the fixture's text, which sits in the top third.
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height * 0.9)

  await expect(page.locator('[data-patch-input]')).toHaveCount(0)
  // And the select tool is still in hand -- nothing was hit, so nothing
  // should have changed underneath the user.
  await expect(page.locator('[data-patch-layer]')).toHaveCount(0)
})

/**
 * And the same gesture on the other half of what a document already
 * contains.
 *
 * The image path is the one that cannot be checked in jsdom at all: it
 * hit-tests boxes the worker reports in MuPDF page space against a pointer
 * converted through `getScreenCTM()`, so a coordinate-space mistake would
 * show up as "double-clicking the logo does nothing" and nowhere else.
 */
test('double-clicking an image the document came with picks it up', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('input[type=file]', WITH_IMAGE)
  await expect(page.getByRole('img', { name: 'Page 1', exact: true })).toBeVisible()

  // Where the image is, asked of the tool that draws targets over them.
  await page.getByRole('button', { name: 'Edit image' }).first().click()
  const target = page.locator('[data-image-target]').first()
  await expect(target).toBeVisible()
  const box = (await target.boundingBox())!
  await page.getByRole('button', { name: 'Select', exact: true }).first().click()
  await expect(page.locator('[data-image-target]')).toHaveCount(0)

  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)

  // Lifted into a real object and selected, so the toolbar is there to move
  // it, resize it, or delete it.
  await expect(page.locator('[data-object-id]')).toHaveCount(1)
  await expect(page.locator('[data-selection]')).toHaveCount(1)
})

/**
 * Arrow keys move what is selected.
 *
 * A browser test because jsdom cannot say whether the keys reach the app
 * at all with real focus, and because a nudge is a claim about where
 * something ends up on screen.
 *
 * The "page stayed put" assertion is a REGRESSION GUARD rather than a
 * demonstration: no engine scrolls this shell on an arrow press today,
 * because nothing puts focus inside the page scroller. The day something
 * does -- a tabindex added for keyboard accessibility would be enough --
 * nudging would start dragging the document along with the object, and
 * this is what would notice.
 */
test('arrow keys move the selection without scrolling the page', async ({ page }, testInfo) => {
  // The edit shortcuts are installed from the desktop shell; the phone
  // shell has no physical keyboard to install them for.
  test.skip(testInfo.project.name === 'phone', 'keyboard shortcuts are desktop-only')
  await openFixture(page)

  await page.getByRole('button', { name: 'Rectangle' }).first().click()
  await drawOn(page, { x: 60, y: 80 }, { x: 200, y: 180 })
  const selection = page.locator('[data-selection]')
  await expect(selection).toHaveCount(1)

  const paper = page.locator('[data-page-id]').first()
  const before = (await selection.boundingBox())!
  const paperBefore = (await paper.boundingBox())!

  // 50pt down, in five shifted steps.
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowDown')

  const after = (await selection.boundingBox())!
  expect(after.y - before.y).toBeGreaterThan(40)
  expect(Math.abs(after.x - before.x)).toBeLessThan(2)

  // The page stayed exactly where it was: the arrows moved the object, not
  // the document. See the note above -- a guard, not a demonstration.
  const paperAfter = (await paper.boundingBox())!
  expect(Math.abs(paperAfter.y - paperBefore.y)).toBeLessThan(2)

  // And the whole run is one thing to undo, not five.
  await page.locator('[data-undo]').click()
  const undone = (await selection.boundingBox())!
  expect(Math.abs(undone.y - before.y)).toBeLessThan(2)
})
