import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import type { ConsoleMessage, Response } from '@playwright/test'

// Real in-browser verification of the Web Worker + WASM boundary (Task 15a).
// No real viewer exists yet (Tasks 17/20 build it), so the only observable
// signal used to be DropZone disappearing when the document store's status
// flips to 'ready' — which only happens after the worker has booted, fetched
// and instantiated the 10.4MB MuPDF WASM binary, parsed a real PDF, and
// returned a page count back across the Comlink boundary. That is a genuine
// end-to-end signal, not a synthetic worker-boot ping.
//
// Task 16 (A3) adds a second, stronger signal: App.vue now renders one
// PageCanvas for page 0 once the document is ready, sourced from a real
// `getPdfClient().render(0, devicePixelRatio)` call. A unit test mocking
// `getContext` cannot distinguish a canvas that paints from a silent
// no-op (this is exactly how DropZone shipped unmounted for a full task
// with 124 green tests) — so this spec reads the canvas's actual pixels
// back out and asserts some of them are not white. The fixture's first
// page has visible text, so an all-white canvas means the render pipeline
// (worker render call -> transferred rgba -> BitmapCache/props -> canvas
// putImageData) silently failed somewhere, even though every unit test
// passes.

const FIXTURE = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/multi-page.pdf', import.meta.url),
)

test('worker boots, loads WASM, and opens a real PDF', async ({ page }, testInfo) => {
  // Desktop only, per the brief — the phone project is Task 21's. The real
  // enforcement is `testIgnore` on the `phone` project in
  // playwright.config.ts: this file destructures `page`, so Playwright
  // resolves (and launches a browser for) that fixture before this line
  // ever runs — an in-body `test.skip` alone cannot stop that launch
  // attempt, which is exactly what let the bare `playwright test`
  // invocation silently run (and fail to launch WebKit for) this file under
  // `phone`. Kept here too, defensively, in case `testIgnore` is ever
  // loosened without this comment being noticed.
  test.skip(testInfo.project.name !== 'desktop', 'desktop only')

  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  let wasmResponse: Response | undefined

  // Registered before goto() — attaching after would miss exactly the
  // errors this test exists to catch (WASM instantiation failures,
  // Comlink deserialise errors during the module worker's boot).
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err: Error) => {
    pageErrors.push(err.stack ?? err.message)
  })
  page.on('response', (res: Response) => {
    if (res.url().endsWith('.wasm')) wasmResponse = res
  })

  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Open a PDF' })).toBeVisible()

  const openStart = Date.now()
  await page.setInputFiles('input[type=file]', FIXTURE)

  // Generous timeout: first load fetches and instantiates 10.4MB of WASM.
  await expect(page.getByRole('heading', { name: 'Open a PDF' })).not.toBeVisible({
    timeout: 30_000,
  })
  // Not an assertion — just a visible record of how long open() actually
  // took in this run, from file-drop to the drop zone disappearing.
  console.log(`[timing] file-drop to drop-zone-gone: ${Date.now() - openStart}ms`)

  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toEqual([])
  expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toEqual([])

  expect(wasmResponse, 'no .wasm request was observed').toBeDefined()
  expect(wasmResponse?.status()).toBe(200)

  // Task 16 (A3): prove the canvas actually painted, not just that it
  // exists. Wait for the canvas element itself first...
  //
  // Scoped to "Page 1" (Task 17): PageList is a virtualized, multi-page
  // scroller — with a correctly sized viewport it legitimately mounts
  // several page canvases at once (this fixture is 12 pages), so a bare
  // `page.locator('canvas')` is a strict-mode violation once more than one
  // is on screen. `[role="img"][aria-label="Page N"]` is PageCanvas's own
  // accessible label (see PageCanvas.vue), the same scoping the Task 17
  // scroll spec below uses.
  const canvas = page.getByRole('img', { name: 'Page 1' }).locator('canvas')
  await expect(canvas).toBeVisible()

  // ...then wait for its pixels to actually be non-white. The canvas can
  // exist in the DOM for one frame before `putImageData` has run (the
  // element mounts, then the async render resolves and paints), so poll
  // rather than sampling once immediately after visibility.
  const nonWhiteFraction = await page.waitForFunction(
    () => {
      const el = Array.from(document.querySelectorAll('canvas')).find(
        (c) => c.closest('[role="img"]')?.getAttribute('aria-label') === 'Page 1',
      )
      if (!el || el.width === 0 || el.height === 0) return false
      const ctx = el.getContext('2d')
      if (!ctx) return false
      const { data } = ctx.getImageData(0, 0, el.width, el.height)
      let nonWhite = 0
      const totalPixels = data.length / 4
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) nonWhite++
      }
      const fraction = nonWhite / totalPixels
      // The fixture's first page has visible text/content, so require a
      // real, non-trivial fraction of non-white pixels, not just one stray
      // pixel (which would also pass an off-by-nothing "> 0" check).
      return fraction > 0.001 ? fraction : false
    },
    undefined,
    { timeout: 15_000 },
  )
  const fraction = (await nonWhiteFraction.jsonValue()) as number
  console.log(`[pixels] non-white fraction of page-0 canvas: ${(fraction * 100).toFixed(2)}%`)
  expect(fraction).toBeGreaterThan(0.001)
})

// Task 17: proves the prioritized render queue, the viewport store, and the
// virtualized PageList actually work together in a real browser, not just
// under mocks. Every unit test for this task mocks the worker (pdfClient)
// and the canvas 2D context, so a unit suite alone cannot tell a genuinely
// wired scroll-to-render pipeline from one where PageList mounts but never
// pumps, or where the render queue never re-anchors — this project has
// already shipped two Critical defects invisible to a fully green unit
// suite (the worker-boot race in Task 15a, the unmounted DropZone/PageCanvas
// scaffolding in Task 15/16) that only a real browser caught. Opens the
// 12-page fixture (multi-page.pdf), confirms page 1 paints, scrolls the
// document container to the bottom, and confirms a later page paints too —
// i.e. the anchor actually moved and the queue actually rendered something
// new, not just that page 1 stayed on screen forever.
test('scrolling the page list renders later pages as they come into view', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop only')

  const FIXTURE_12P = fileURLToPath(
    new URL('../../../packages/pdf-core/test/fixtures/multi-page.pdf', import.meta.url),
  )

  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err: Error) => {
    pageErrors.push(err.stack ?? err.message)
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Open a PDF' })).toBeVisible()
  await page.setInputFiles('input[type=file]', FIXTURE_12P)
  await expect(page.getByRole('heading', { name: 'Open a PDF' })).not.toBeVisible({
    timeout: 30_000,
  })

  const scroller = page.getByRole('region', { name: 'Document pages' })
  await expect(scroller).toBeVisible()

  // Wait for page 1's canvas to actually paint (non-white pixels), same
  // signal as the test above, before touching scroll — otherwise a "later
  // page painted" result could just mean page 1 never painted at all and
  // this test is comparing two blank canvases.
  async function paintedFraction(label: string): Promise<number> {
    const handle = await scroller.evaluateHandle(
      (root: HTMLElement, ariaLabel: string) => {
        const canvases = Array.from(root.querySelectorAll('canvas'))
        const target = canvases.find(
          (c) => c.closest('[role="img"]')?.getAttribute('aria-label') === ariaLabel,
        )
        if (!target || target.width === 0 || target.height === 0) return -1
        const ctx = target.getContext('2d')
        if (!ctx) return -1
        const { data } = ctx.getImageData(0, 0, target.width, target.height)
        let nonWhite = 0
        const total = data.length / 4
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) nonWhite++
        }
        return nonWhite / total
      },
      label,
    )
    return handle.jsonValue()
  }

  await expect
    .poll(() => paintedFraction('Page 1'), { timeout: 15_000 })
    .toBeGreaterThan(0.001)

  // Scroll the document container to the bottom so the queue's anchor moves
  // to a late page in the 12-page fixture.
  await scroller.evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight
  })

  await expect
    .poll(() => paintedFraction('Page 12'), { timeout: 15_000 })
    .toBeGreaterThan(0.001)

  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toEqual([])
  expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toEqual([])
})
