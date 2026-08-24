import { test, expect, type Page } from '@playwright/test'

/**
 * Chromium only, deliberately.
 *
 * Playwright's WebKit does not run service workers at all, and its Firefox
 * gives no way to wait for one to take control -- so the same assertions
 * there would either be skipped in the body or would flake. iOS Safari DOES
 * support installing this app and caching it; that path is verified by hand
 * on a device, and this file says so rather than pretending to cover it.
 */
const CHROMIUM_ONLY = 'service workers are only drivable in Playwright Chromium'

type Manifest = {
  name?: string
  short_name?: string
  start_url?: string
  display?: string
  theme_color?: string
  background_color?: string
  icons?: Array<{ src: string; sizes: string; type?: string; purpose?: string }>
  file_handlers?: Array<{ action: string; accept: Record<string, string[]> }>
}

async function manifest(page: Page): Promise<Manifest> {
  const href = await page.locator('link[rel="manifest"]').getAttribute('href')
  expect(href, 'the page declares no manifest, so no browser will offer to install it').toBeTruthy()
  const res = await page.request.get(new URL(href!, page.url()).toString())
  expect(res.status()).toBe(200)
  return (await res.json()) as Manifest
}

/** Resolves once a service worker controls this page. */
async function serviceWorkerReady(page: Page): Promise<void> {
  await page.waitForFunction(async () => {
    if (!('serviceWorker' in navigator)) return false
    await navigator.serviceWorker.ready
    return navigator.serviceWorker.controller !== null
  }, null, { timeout: 30_000 })
}

test.describe('installable', () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', CHROMIUM_ONLY)
  })

  test('the manifest describes a standalone app a browser will install', async ({ page }) => {
    await page.goto('/')

    const m = await manifest(page)

    expect(m.name).toBeTruthy()
    expect(m.short_name).toBeTruthy()
    expect(m.start_url).toBeTruthy()
    expect(m.display).toBe('standalone')
    expect(m.background_color, 'without this the app flashes white on launch').toBeTruthy()

    // Chrome's install criteria: an icon of at least 192px, plus a 512px
    // one for the splash screen. Anything less and the prompt never appears.
    const sizes = (m.icons ?? []).map((i) => i.sizes)
    expect(sizes).toContain('192x192')
    expect(sizes).toContain('512x512')

    // Android crops icons to a device-chosen shape. Without a maskable
    // icon it crops the standard one, which cuts the corners off the mark.
    expect(
      (m.icons ?? []).some((i) => i.purpose?.split(' ').includes('maskable')),
      'no maskable icon: Android will crop the square one',
    ).toBe(true)
  })

  test('every icon the manifest promises actually exists', async ({ page }) => {
    await page.goto('/')
    const m = await manifest(page)
    expect(m.icons?.length, 'a manifest with no icons is not installable').toBeGreaterThan(0)

    for (const icon of m.icons!) {
      const res = await page.request.get(new URL(icon.src, page.url()).toString())
      expect(res.status(), `${icon.src} is declared but not served`).toBe(200)
      expect(res.headers()['content-type']).toContain('image')
    }
  })

  test('the app offers itself to the OS as a PDF handler', async ({ page }) => {
    await page.goto('/')

    const m = await manifest(page)

    const accepts = (m.file_handlers ?? []).flatMap((h) => Object.entries(h.accept))
    expect(accepts.some(([mime]) => mime === 'application/pdf')).toBe(true)
    expect(accepts.some(([, exts]) => exts.includes('.pdf'))).toBe(true)
  })
})

test.describe('offline', () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', CHROMIUM_ONLY)
  })

  test('a service worker takes control of the page', async ({ page }) => {
    await page.goto('/')

    await serviceWorkerReady(page)

    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
  })

  /**
   * OFFLINE FROM THE SECOND VISIT, and the second visit is not incidental.
   *
   * MuPDF's 10 MB wasm is in the MAIN bundle, not only the worker's --
   * `@margin/pdf-core` re-exports modules that `import * as mupdf`, so the
   * binary is instantiated on every page load whether or not a document is
   * open. The app therefore cannot boot at all without it, cached or
   * fetched.
   *
   * On a FIRST visit that fetch is already in flight before the service
   * worker has installed, activated and claimed the page, so it never
   * passes through the runtime cache. Nothing can win that race: moving
   * the registration earlier does not make install-and-activate
   * synchronous. The alternative -- precaching the wasm -- would download
   * it a second time during install, on the one visit where the user is
   * already waiting on the first copy.
   *
   * So the contract is: visit once online, and it works offline from then
   * on. This test spells that out rather than hiding the extra load.
   */
  test('the editor still opens with the network cut, once it has been visited once', async ({
    page,
    context,
  }) => {
    await page.goto('/')
    await serviceWorkerReady(page)

    // The second visit: now controlled from the first byte, so the wasm
    // request reaches the runtime cache.
    await page.reload()
    await expect(page.locator('[data-empty-state]')).toBeVisible()
    await expect
      .poll(async () =>
        page.evaluate(async () => (await caches.open('margin-wasm')).keys().then((k) => k.length)),
      )
      .toBeGreaterThan(0)

    await context.setOffline(true)
    await page.reload()

    // The empty state, served entirely from the cache. Not a network error
    // page, and not a blank document.
    await expect(page.locator('[data-empty-state]')).toBeVisible()
    await context.setOffline(false)
  })

  /**
   * The precache is downloaded IN FULL before the app is usable offline,
   * so what goes in it is a budget, not a preference. MuPDF's wasm is
   * 10 MB unzipped and the fonts are another 1.6 MB; precaching either
   * would turn a first visit into a multi-megabyte download for a feature
   * the user has not asked for yet. Both are cached at runtime instead --
   * on first use, when the cost is one the user is already paying.
   */
  test('the precache holds the shell, not the 10 MB of wasm and fonts', async ({ page }) => {
    await page.goto('/')
    await serviceWorkerReady(page)

    const cached = await page.evaluate(async () => {
      const names = await caches.keys()
      const urls: string[] = []
      for (const name of names) {
        if (!name.includes('precache')) continue
        for (const req of await (await caches.open(name)).keys()) urls.push(req.url)
      }
      return urls
    })

    expect(cached.length, 'nothing was precached — the shell will not load offline').toBeGreaterThan(2)
    expect(cached.filter((u) => u.includes('.wasm'))).toEqual([])
    expect(cached.filter((u) => u.includes('/fonts/'))).toEqual([])
  })
})
