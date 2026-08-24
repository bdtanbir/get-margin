import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/multi-page.pdf', import.meta.url),
)

/**
 * Two-finger gestures, driven through Chromium's real input pipeline.
 *
 * `Input.dispatchTouchEvent` is not a synthetic DOM event: it enters where a
 * real touch does, so `touch-action` arbitration, native scrolling and
 * momentum all behave as they do on a device. That matters more than usual
 * here, because the bug class this guards against is entirely about who wins
 * a gesture -- the page or the browser -- and a dispatched DOM event never
 * asks that question. See the `touch` project in playwright.config.ts.
 */

const scrollerOf = (page: Page) => page.getByRole('region', { name: 'Document pages' })
const zoomLabel = (page: Page) => page.getByRole('button', { name: 'Reset zoom to 100%' })

async function openDocument(page: Page): Promise<void> {
  await page.goto('/')
  await page.setInputFiles('input[type=file]', FIXTURE)
  await expect(page.getByRole('img', { name: 'Page 1', exact: true }).locator('canvas'))
    .toBeVisible({ timeout: 30_000 })
  await expect(zoomLabel(page)).toBeVisible()
}

async function zoomPercent(page: Page): Promise<number> {
  return Number((await zoomLabel(page).textContent())!.replace('%', '').trim())
}

/**
 * Two fingers on a horizontal line about the scroller's centre.
 *
 * `spread` is a FRACTION of the furthest the fingers can go while both
 * stay inside the scroller, not a pixel count. The scroller does not start
 * at x = 0 on a phone -- the tool rail owns the first 48px -- so a spread
 * in pixels large enough to be an interesting pinch put one finger on the
 * rail and the other past the right edge. Neither touch reached the
 * scroller, no contact was ever registered, and the gesture looked
 * broken while the code was fine.
 */
async function pinch(
  page: Page,
  context: BrowserContext,
  { from, to }: { from: number; to: number },
): Promise<void> {
  const cdp = await context.newCDPSession(page)
  const box = (await scrollerOf(page).boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  // 24px of margin so a rounded coordinate cannot land on the boundary.
  const reach = box.width / 2 - 24
  expect(reach, 'the scroller is too narrow to express a pinch').toBeGreaterThan(60)
  const points = (fraction: number) => [
    { x: cx - reach * fraction, y: cy, id: 1 },
    { x: cx + reach * fraction, y: cy, id: 2 },
  ]

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from) })
  const steps = 12
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: points(from + ((to - from) * i) / steps),
    })
    await page.waitForTimeout(24)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(400)
}

/**
 * One finger dragged upward, which should scroll the document down.
 *
 * Returns the scroll position reached WHILE THE FINGER IS STILL DOWN, read
 * immediately before `touchEnd`. Measuring after the lift measures
 * something else entirely: the browser dispatches a fling from the
 * gesture's final velocity, and that inertia is both desirable and
 * variable -- three runs of the same drag landed 226px, 239px and 250px
 * after momentum, against 188/186/185 before it. Only the during-drag
 * number says whether the content tracks the finger.
 */
async function dragUp(page: Page, context: BrowserContext, distance: number): Promise<number> {
  const cdp = await context.newCDPSession(page)
  const box = (await scrollerOf(page).boundingBox())!
  const x = box.x + box.width / 2
  let y = box.y + box.height * 0.8

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
  const steps = 20
  for (let i = 0; i < steps; i++) {
    y -= distance / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] })
    await page.waitForTimeout(16)
  }
  const tracked = await scrollerOf(page).evaluate((el) => el.scrollTop)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  return tracked
}

test.describe('pinch to zoom', () => {
  test('spreading two fingers zooms the document in', async ({ page, context }) => {
    await openDocument(page)
    const before = await zoomPercent(page)

    await pinch(page, context, { from: 0.25, to: 1 })

    expect(await zoomPercent(page)).toBeGreaterThan(before)
  })

  test('bringing two fingers together zooms it out', async ({ page, context }) => {
    await openDocument(page)
    await pinch(page, context, { from: 0.25, to: 1 })
    const zoomedIn = await zoomPercent(page)

    await pinch(page, context, { from: 1, to: 0.25 })

    expect(await zoomPercent(page)).toBeLessThan(zoomedIn)
  })

  /**
   * The document zooms, the PAGE does not. If `touch-action` ever stopped
   * excluding pinch-zoom, the browser would scale the whole interface
   * instead and the app would never see the gesture -- which looks, from
   * the outside, exactly like a broken zoom.
   */
  test('the browser does not zoom the interface instead', async ({ page, context }) => {
    await openDocument(page)

    await pinch(page, context, { from: 0.25, to: 1 })

    expect(await page.evaluate(() => visualViewport!.scale)).toBeCloseTo(1, 1)
  })
})

test.describe('one finger pans', () => {
  test('dragging up scrolls the document down', async ({ page, context }) => {
    await openDocument(page)
    const scroller = scrollerOf(page)
    await scroller.evaluate((el) => { el.scrollTop = 0 })

    await dragUp(page, context, 200)

    expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  })

  /**
   * The content tracks the finger one-for-one.
   *
   * Two mechanisms could scroll this element for one gesture -- the
   * browser, because `touch-action: pan-x pan-y` permits it, and the app's
   * own `onPan` handler. If both ever did, the document would travel twice
   * as far as the finger, which is the classic "the page runs away from
   * me" feel. It does not today: the browser claims the gesture and
   * pointer delivery stops, so `onPan` contributes almost nothing. This
   * asserts that arrangement rather than assuming it.
   *
   * The lower bound matters as much as the upper: touch slop eats the
   * first few pixels, so the honest expectation is slightly UNDER the
   * drag, never over.
   */
  test('scrolls one-for-one with the finger, not twice as far', async ({ page, context }) => {
    await openDocument(page)
    const scroller = scrollerOf(page)
    await scroller.evaluate((el) => { el.scrollTop = 0 })

    const DRAG = 200
    const tracked = await dragUp(page, context, DRAG)

    expect(tracked, `${tracked}px of scroll for a ${DRAG}px drag`).toBeGreaterThan(DRAG * 0.75)
    expect(tracked, `${tracked}px of scroll for a ${DRAG}px drag`).toBeLessThan(DRAG * 1.05)
  })

  test('panning still works after a pinch', async ({ page, context }) => {
    await openDocument(page)
    await pinch(page, context, { from: 0.25, to: 1 })
    const scroller = scrollerOf(page)
    await scroller.evaluate((el) => { el.scrollTop = 0 })

    await dragUp(page, context, 150)

    expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  })
})
