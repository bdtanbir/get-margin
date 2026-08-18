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
  const canvas = page.locator('canvas')
  await expect(canvas).toBeVisible()

  // ...then wait for its pixels to actually be non-white. The canvas can
  // exist in the DOM for one frame before `putImageData` has run (the
  // element mounts, then the async render resolves and paints), so poll
  // rather than sampling once immediately after visibility.
  const nonWhiteFraction = await page.waitForFunction(
    () => {
      const el = document.querySelector('canvas')
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
