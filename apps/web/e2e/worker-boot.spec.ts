import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import type { ConsoleMessage, Response } from '@playwright/test'
import { ZOOM_STEPS, nextZoomStep } from '../src/lib/fit.js'

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

  // The empty state is identified by a stable hook, not its heading text:
  // that copy is product wording and changed once already, breaking a dozen
  // selectors across three specs at once.
  await expect(page.locator('[data-empty-state]')).toBeVisible()

  const openStart = Date.now()
  await page.setInputFiles('input[type=file]', FIXTURE)

  // Generous timeout: first load fetches and instantiates 10.4MB of WASM.
  await expect(page.locator('[data-empty-state]')).not.toBeVisible({
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
  // scroll spec below uses. `exact: true` matters here: Playwright's
  // accessible-name matching is substring by default, so a loose match on
  // "Page 1" would also match "Page 10"/"Page 11"/"Page 12" in this
  // 12-page fixture.
  const canvas = page.getByRole('img', { name: 'Page 1', exact: true }).locator('canvas')
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
        // alpha === 255 matters, not just "RGB isn't white": a <canvas>
        // that was created (it passes the `el`/width/height checks above)
        // but never actually painted is fully TRANSPARENT (0,0,0,0) per
        // spec, not white — an RGB-only check would count every pixel of a
        // silently-broken, never-painted canvas as "non-white" and pass. The
        // real render pipeline always forces full opacity (packages/pdf-core
        // /src/render.ts), so requiring alpha === 255 is a no-op for a
        // genuine render and a hard filter against an unpainted one.
        if (data[i + 3] === 255 && (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255)) nonWhite++
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
  await expect(page.locator('[data-empty-state]')).toBeVisible()
  await page.setInputFiles('input[type=file]', FIXTURE_12P)
  await expect(page.locator('[data-empty-state]')).not.toBeVisible({
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
          // alpha === 255 required — see the identical comment on the
          // page-1 check above: an unpainted canvas is transparent
          // (0,0,0,0), not white, and would otherwise be miscounted as
          // "non-white content".
          if (data[i + 3] === 255 && (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255)) nonWhite++
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

// Task 18: proves zoom actually changes the rendered page size in a real
// browser, not just that the store's `zoom` ref changes value. Every unit
// test for this task mocks the worker and the canvas 2D context (fit.test.ts
// tests pure math; viewport.test.ts asserts on cache/call counts) — none of
// them render a real <canvas> element, so none of them can catch a wiring
// gap where `zoomIn()` updates the store but PageCanvas/PageList never
// re-renders at the new size. This project has already shipped two Critical
// defects invisible to a fully green unit suite for exactly that reason
// (the worker-boot race in Task 15a, the unmounted DropZone/PageCanvas
// scaffolding in Task 15/16), so this spec opens the fixture, records page
// 1's actual rendered bounding-box width, clicks the zoom pill's "Zoom in"
// button, and asserts the on-screen width changed and grew.
test('zoom in changes the rendered page size', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop only')

  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err: Error) => {
    pageErrors.push(err.stack ?? err.message)
  })

  await page.goto('/')
  await expect(page.locator('[data-empty-state]')).toBeVisible()
  await page.setInputFiles('input[type=file]', FIXTURE)
  await expect(page.locator('[data-empty-state]')).not.toBeVisible({
    timeout: 30_000,
  })

  const page1 = page.getByRole('img', { name: 'Page 1', exact: true })
  await expect(page1).toBeVisible()

  // Wait for the initial render (fit-width, applied on mount) to actually
  // paint before recording a "before" size, same reasoning as the tests
  // above: a size change against a canvas that never painted at all would
  // be a false positive.
  const canvas = page1.locator('canvas')
  await expect
    .poll(async () => {
      const box = await canvas.boundingBox()
      return box?.width ?? 0
    }, { timeout: 15_000 })
    .toBeGreaterThan(0)

  const before = await page1.boundingBox()
  expect(before, 'page 1 has no bounding box before zoom').not.toBeNull()

  const zoomIn = page.getByRole('button', { name: 'Zoom in' })
  await expect(zoomIn).toBeVisible()
  await zoomIn.click()

  // A bare "> before.width" would pass on a one-pixel nudge, a jump to the
  // wrong preset, or "Zoom in" accidentally wired to some other multiplier
  // entirely — as long as the page got fractionally bigger in both axes.
  // This is exactly the shape of defect this project has caught four times
  // (an endpoints-only compositing test where both candidate formulas
  // agreed, an all-white golden image, a leaked-listener test that still
  // passed, a substring locator matching the wrong element), so a flat
  // percentage floor was never quite right — and got worse when Task 19
  // added ThumbnailPanel as a permanent 240px sidebar (see App.vue): the
  // viewer column shrank from the full 1440px viewport to ~1200px, so
  // fit-width now lands on a smaller preset gap (~1.86x -> 2x, ~7.7%
  // growth) than before the sidebar existed (~2.24x -> 3x, ~34% growth). A
  // flat threshold has to sit meaningfully below whatever the real growth
  // happens to be at the time, which means any future chrome that narrows
  // the viewer further pushes the real number toward the threshold and
  // makes the test flaky — the margin shrinks even though nothing is wrong.
  //
  // `ZOOM_STEPS`/`nextZoomStep` (apps/web/src/lib/fit.ts) are pure,
  // Node-importable functions with no Vue/browser dependency, so rather
  // than asserting a flat lower bound this derives the actual expected
  // pixel width from the SAME preset table the app uses, and asserts
  // equality against that — tighter than any percentage floor could be,
  // and immune to future chrome changing how much the viewer narrows.
  // `before.width` is `Math.round(612 * zoomBefore)` (PageCanvas's cssWidth
  // — see PageCanvas.vue), so `before.width / 612` recovers `zoomBefore` to
  // within ~1/612 (~0.0016) of the real value — negligible next to the gap
  // between adjacent ZOOM_STEPS entries, so it cannot land in the wrong
  // preset bucket. This avoids exposing the store's internal zoom value on
  // `window` purely for test convenience, which the original version of
  // this comment explicitly ruled out.
  const PAGE_WIDTH_PT = 612 // this fixture's Letter page width, in points
  const PAGE_HEIGHT_PT = 792
  const zoomBefore = before!.width / PAGE_WIDTH_PT
  const expectedZoomAfter = nextZoomStep(zoomBefore, 1)
  const expectedWidthAfter = Math.round(expectedZoomAfter * PAGE_WIDTH_PT)
  const expectedHeightAfter = Math.round(expectedZoomAfter * PAGE_HEIGHT_PT)
  console.log(
    `[zoom] before: ${before!.width}px (zoom ~${zoomBefore.toFixed(4)}), ` +
    `expected preset after 'Zoom in': ${expectedZoomAfter}x (${ZOOM_STEPS.join(', ')}) ` +
    `-> expected width ${expectedWidthAfter}px`,
  )

  // Poll rather than assert once immediately: the click triggers
  // setZoom -> dirty=true -> pump() -> a real worker render -> repaint,
  // all asynchronous.
  await expect
    .poll(async () => (await page1.boundingBox())?.width ?? 0, { timeout: 15_000 })
    .toBe(expectedWidthAfter)

  const after = await page1.boundingBox()
  console.log(
    `[zoom] page 1 width before: ${before!.width.toFixed(1)}px, after: ${after!.width.toFixed(1)}px ` +
    `(ratio ${(after!.width / before!.width).toFixed(3)})`,
  )
  expect(after!.width).toBe(expectedWidthAfter)
  expect(after!.height).toBe(expectedHeightAfter)

  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toEqual([])
  expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toEqual([])
})

// Task 19: proves the thumbnail panel's canvases actually paint real page
// content, not just that the panel and its frames exist in the DOM. Every
// unit test for this task (Thumbnail.test.ts, ThumbnailPanel.test.ts) mocks
// the viewport store's `bitmapFor` (implicitly, via never populating the
// cache) or asserts on props/emits/markup — none of them exercise the real
// render queue, so none of them can tell a thumbnail that genuinely paints
// its placeholder-tier bitmap from one whose canvas ref never actually
// wires up `putImageData`, or whose frame is present but permanently blank.
// This is exactly the shape of defect this project has already shipped
// twice with a fully green unit suite (Task 15a's worker-boot race, Task
// 15/16's unmounted DropZone/PageCanvas) — an empty-frames thumbnail panel
// would look completely plausible in a screenshot and pass any structural
// ("N buttons rendered", "aria-current toggles") test.
//
// The thumbnail checked here (page 8 of 12) is deliberately NOT the anchor
// page or one of its immediate neighbours (PageList's VISIBLE_RADIUS is 1,
// so only pages ~0-1 get a full-resolution render on initial load): its
// bitmap can only have come from the placeholder tier (Task 17's
// PLACEHOLDER_SCALE render), which is the specific pipeline this test
// exists to verify end-to-end. Nothing scrolls the document in this test,
// so a bug that only fed the placeholder tier to PageList (never to
// Thumbnail) would leave this thumbnail blank while page 1's main canvas
// still painted fine.
test('thumbnail panel renders real page content from the placeholder tier', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop only')

  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err: Error) => {
    pageErrors.push(err.stack ?? err.message)
  })

  await page.goto('/')
  await expect(page.locator('[data-empty-state]')).toBeVisible()
  await page.setInputFiles('input[type=file]', FIXTURE)
  await expect(page.locator('[data-empty-state]')).not.toBeVisible({
    timeout: 30_000,
  })

  const panel = page.getByRole('complementary', { name: 'Pages' })
  await expect(panel).toBeVisible()

  // 12 thumbnail buttons, one per page — the panel is actually wired to
  // pageOrder, not stubbed with a fixed count.
  //
  // Scoped to the tiles: since Phase 3 the panel's header also carries page
  // actions (add a PDF, split), so counting every button in the panel would
  // shift the moment another control is added there.
  await expect(panel.locator('[data-page-tile] button')).toHaveCount(12)

  // `exact: true` matters here for the same reason it does on the page-1
  // check above: accessible-name matching is substring by default, and
  // "Go to page 1" would also match "Go to page 10"/"11"/"12" in this
  // 12-page fixture.
  const thumb8 = panel.getByRole('button', { name: 'Go to page 8', exact: true })
  await expect(thumb8).toBeVisible()
  const canvas = thumb8.locator('canvas')
  await expect(canvas).toBeVisible()

  // Poll rather than sample once: the placeholder render for page 8 is
  // queued behind the anchor's full render and arrives asynchronously from
  // a real worker call, same as the page-1 checks above.
  const nonBlankFraction = await page.waitForFunction(
    () => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.getAttribute('aria-label') === 'Go to page 8',
      )
      const el = btn?.querySelector('canvas')
      if (!el || el.width === 0 || el.height === 0) return false
      const ctx = el.getContext('2d')
      if (!ctx) return false
      const { data } = ctx.getImageData(0, 0, el.width, el.height)
      let nonBlank = 0
      const totalPixels = data.length / 4
      for (let i = 0; i < data.length; i += 4) {
        // alpha === 255 required — see the identical comment on the page-1
        // check above. Verified this matters here specifically: with this
        // omitted, an intentionally-broken (never-painted) thumbnail canvas
        // reads as "100% non-blank" instead of failing, because a
        // transparent (0,0,0,0) pixel isn't white either.
        if (data[i + 3] === 255 && (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255)) nonBlank++
      }
      const fraction = nonBlank / totalPixels
      return fraction > 0.001 ? fraction : false
    },
    undefined,
    { timeout: 15_000 },
  )
  const fraction = (await nonBlankFraction.jsonValue()) as number
  console.log(`[pixels] non-blank fraction of thumbnail-8 canvas: ${(fraction * 100).toFixed(2)}%`)
  expect(fraction).toBeGreaterThan(0.001)

  // The thumbnail frame preserves the page's aspect ratio (portrait, in
  // this fixture) rather than being force-squared — a stretched thumbnail
  // would still pass the pixel check above.
  const box = await canvas.boundingBox()
  expect(box, 'thumbnail canvas has no bounding box').not.toBeNull()
  expect(box!.height).toBeGreaterThan(box!.width)

  // Clicking a thumbnail actually moves the viewport: page 8's main canvas
  // should paint after the click, proving ThumbnailPanel's `select` handler
  // is wired to the real viewport store, not just emitting an event nobody
  // listens to. This check caught a real defect during development: jumping
  // straight to a page whose PageCanvas is already mounted at one bitmap
  // tier (placeholder) and then receives a differently-sized one (full-res)
  // raced Vue's reactive `:width`/`:height` canvas bindings against the
  // paint watcher, silently wiping the just-painted content — fixed in
  // PageCanvas.vue by switching that watcher to `flush: 'post'`.
  await thumb8.click()
  await expect
    .poll(
      async () => {
        return page.evaluate(() => {
          const el = Array.from(document.querySelectorAll('canvas')).find(
            (c) => c.closest('[role="img"]')?.getAttribute('aria-label') === 'Page 8',
          )
          if (!el || el.width === 0 || el.height === 0) return -1
          const ctx = el.getContext('2d')
          if (!ctx) return -1
          const { data } = ctx.getImageData(0, 0, el.width, el.height)
          let nonWhite = 0
          const total = data.length / 4
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] === 255 && (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255)) nonWhite++
          }
          return nonWhite / total
        })
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0.001)

  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toEqual([])
  expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toEqual([])
})

// Task 20: proves DesktopShell and MobileShell both actually mount, and
// that the breakpoint switch (apps/web/src/lib/breakpoint.ts, consumed by
// App.vue) works in a real browser with a document already open — not just
// that `useShell().isDesktop` flips in a unit test (breakpoint.test.ts
// covers that in isolation, with mocked `window.innerWidth`). Every unit
// test for this task mocks the worker and the DOM, so none of them can
// catch a wiring gap where the shell swaps but PageList/the viewport store
// don't survive the swap (e.g. because remounting PageList destroys and
// never recreates its render-priority pump, or because the document store
// gets reset). This project has already shipped multiple defects invisible
// to a fully green unit suite for exactly that reason (the worker-boot race
// in Task 15a, the unmounted DropZone/PageCanvas scaffolding in Task 15/16),
// so this spec opens the fixture at desktop width, asserts DesktopShell's
// chrome (the toggleable ThumbnailPanel/"Toggle pages panel" button, which
// MobileShell never renders) is present, resizes the viewport below
// DESKTOP_MIN_PX (1024px), and asserts MobileShell's chrome (the bottom
// "Document actions" nav, which DesktopShell never renders) appears in its
// place — with the document still open and a page still painting real
// content on both sides of the switch.
//
// WebKit is not installed in this environment (only `playwright install
// chromium` was ever run — see the `phone` project's `testIgnore` comment
// above), so the `phone` project cannot launch a real mobile browser here.
// This resizes the `desktop` project's Chromium viewport across the
// breakpoint instead of using `phone`, which is exactly what the brief
// asks for and is a legitimate way to exercise `useShell` (a plain
// `useWindowSize`-backed resize listener, not a UA/touch check) end to end.
test('the shell swaps between desktop and mobile chrome as the viewport crosses the breakpoint, with the document staying open', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop only')

  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err: Error) => {
    pageErrors.push(err.stack ?? err.message)
  })

  // Desktop width (>= DESKTOP_MIN_PX): the project's default viewport
  // (1440x900, set in playwright.config.ts) already satisfies this, but
  // this is set explicitly so the test does not silently depend on that
  // config default staying above 1024px.
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(page.locator('[data-empty-state]')).toBeVisible()
  await page.setInputFiles('input[type=file]', FIXTURE)
  await expect(page.locator('[data-empty-state]')).not.toBeVisible({
    timeout: 30_000,
  })

  async function paintedFraction(label: string): Promise<number> {
    return page.evaluate((ariaLabel: string) => {
      const el = Array.from(document.querySelectorAll('canvas')).find(
        (c) => c.closest('[role="img"]')?.getAttribute('aria-label') === ariaLabel,
      )
      if (!el || el.width === 0 || el.height === 0) return -1
      const ctx = el.getContext('2d')
      if (!ctx) return -1
      const { data } = ctx.getImageData(0, 0, el.width, el.height)
      let nonWhite = 0
      const total = data.length / 4
      for (let i = 0; i < data.length; i += 4) {
        // alpha === 255 required — see the identical comment on the page-1
        // check above: an unpainted canvas is transparent (0,0,0,0), not
        // white, and would otherwise be miscounted as "non-white content".
        if (data[i + 3] === 255 && (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255)) nonWhite++
      }
      return nonWhite / total
    }, label)
  }

  // DesktopShell-only chrome: TopBar's "Toggle pages panel" button only
  // renders when `!compact` (DesktopShell passes no `compact` prop;
  // MobileShell passes `compact`), and ThumbnailPanel (an `aside` with
  // accessible name "Pages") is only mounted by DesktopShell in Phase 1 —
  // MobileShell only shows it inside the Pages modal, which is closed by
  // default. Both together are a much stronger signal than either alone:
  // a shell that rendered the wrong TopBar variant but happened to also
  // mount an unrelated "Pages"-labelled element would still fail one of
  // these two checks.
  await expect(page.getByRole('button', { name: 'Toggle pages panel' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Pages' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Document actions' })).toHaveCount(0)

  await expect
    .poll(() => paintedFraction('Page 1'), { timeout: 15_000 })
    .toBeGreaterThan(0.001)

  // The document must still be identifiable as open (TopBar shows the real
  // file name, not "No document") before resizing — otherwise a pass below
  // could just mean the document was never really open in the first place.
  await expect(page.getByText('multi-page.pdf')).toBeVisible()

  // Cross the breakpoint downward. DESKTOP_MIN_PX is 1024; 800 is
  // comfortably below it without being an unrealistic phone width, so this
  // also stands in for a narrow desktop/tablet window, not just a phone.
  //
  // Amendment A4 (Task 21): this used to follow with a magic-number
  // `waitForTimeout(300)` to give useWindowSize's resize listener and
  // Vue's reactivity a tick to settle before asserting. Removed rather than
  // replaced: `expect(locator).toBeVisible()` / `.toHaveCount()` below are
  // already Playwright auto-retrying assertions (default 5s), so they poll
  // through exactly the same settling window on their own — the fixed
  // sleep was redundant with assertions that already retry, not a
  // requirement of its own. Confirmed by running this spec with the sleep
  // removed: still green.
  await page.setViewportSize({ width: 800, height: 900 })

  // MobileShell-only chrome: the bottom "Document actions" nav (only
  // rendered once `doc.isReady`) replaces DesktopShell's rail entirely.
  await expect(page.getByRole('navigation', { name: 'Document actions' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Toggle pages panel' })).toHaveCount(0)
  // ThumbnailPanel is not gone for good — MobileShell just moved it behind
  // the Pages modal, which starts closed. If DesktopShell's `aside` were
  // still mounted here (a shell-swap that failed to actually unmount the
  // old shell), this would still be visible and the check above would be
  // meaningless.
  await expect(page.getByRole('complementary', { name: 'Pages' })).toHaveCount(0)

  // The document survived the swap: the file name is still shown (the
  // document store was not reset), and *some* page is still painted with
  // real content (PageList/the viewport store's render pump kept working
  // after remounting under the new shell, not just that a canvas element
  // exists). Not necessarily "Page 1" specifically: PageList's own
  // pre-existing anchor-recentering watcher ("Keep the render anchor
  // pointing at whatever is centred in the viewport", PageList.vue) reacts
  // to the resize-driven refit exactly as it would to any zoom change, and
  // can legitimately move the anchor to a different page — verified this is
  // not a Task 20 regression by reproducing the same anchor drift on a
  // resize/fit change against the pre-Task-20 App.vue (single shell, no
  // TopBar) before writing this assertion. Pinning this check to "Page 1"
  // would make the test flaky against PageList's own intended behavior, not
  // a real signal about the shell swap.
  await expect(page.getByText('multi-page.pdf')).toBeVisible()
  await expect
    .poll(
      () => page.evaluate(() => document.querySelectorAll('[role="img"][aria-label^="Page "]').length),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0)
  const anchoredLabel = await page.evaluate(() => {
    const el = document.querySelector('[role="img"][aria-label^="Page "]')
    return el?.getAttribute('aria-label') ?? null
  })
  expect(anchoredLabel, 'no page is mounted after the breakpoint switch').not.toBeNull()
  await expect
    .poll(() => paintedFraction(anchoredLabel!), { timeout: 15_000 })
    .toBeGreaterThan(0.001)

  // Mobile's touch targets must clear the spec's 44px floor (min-h-11) —
  // checked here rather than only by class-name inspection, since this is
  // the one spot the mobile-only "Pages" bottom-nav button actually exists
  // in the DOM to measure.
  const pagesButton = page.getByRole('button', { name: 'Pages' })
  await expect(pagesButton).toBeVisible()
  const box = await pagesButton.boundingBox()
  expect(box, 'mobile Pages button has no bounding box').not.toBeNull()
  expect(box!.height).toBeGreaterThanOrEqual(44)
  expect(box!.width).toBeGreaterThanOrEqual(44)

  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toEqual([])
  expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toEqual([])
})
