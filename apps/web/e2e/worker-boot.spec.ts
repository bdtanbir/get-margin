import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import type { ConsoleMessage, Response } from '@playwright/test'

// Real in-browser verification of the Web Worker + WASM boundary (Task 15a).
// No viewer exists yet (Tasks 17/20 build it), so the only observable signal
// is DropZone disappearing when the document store's status flips to
// 'ready' — which only happens after the worker has booted, fetched and
// instantiated the 10.4MB MuPDF WASM binary, parsed a real PDF, and
// returned a page count back across the Comlink boundary. That is a
// genuine end-to-end signal, not a synthetic worker-boot ping.
//
// This spec does NOT verify the transfer handler's symmetric registration
// across both realms — open() returns only DocumentInfo, so no pixel
// buffer (and therefore no `Comlink.transfer`) crosses the boundary here.
// A one-sided registration would degrade silently to a copy (a perf
// regression), not a functional failure, and would not be caught by this
// or any purely functional test. Genuine transfer first happens when a
// page is rendered — Task 21's viewer spec is where that gets exercised.

const FIXTURE = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/multi-page.pdf', import.meta.url),
)

test('worker boots, loads WASM, and opens a real PDF', async ({ page }) => {
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

  await page.setInputFiles('input[type=file]', FIXTURE)

  // Generous timeout: first load fetches and instantiates 10.4MB of WASM.
  await expect(page.getByRole('heading', { name: 'Open a PDF' })).not.toBeVisible({
    timeout: 30_000,
  })

  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toEqual([])
  expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toEqual([])

  expect(wasmResponse, 'no .wasm request was observed').toBeDefined()
  expect(wasmResponse?.status()).toBe(200)
})
