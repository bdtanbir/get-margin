// Restores evidence for the "Link annotations have no Rect" claim in
// docs/findings/02-write-path.md (Q1).
//
// CORRECTION on restore: the original findings doc claimed the low-level escape hatch
// (`getObject().put('Rect', ...)`) "hard-aborts the WASM runtime". Re-running this properly
// (with every call individually try/catch-wrapped, below) does NOT reproduce that — the
// low-level put() succeeds without crashing anything. The original ad-hoc probe that produced
// the "abort" observation had an UNWRAPPED `link.getRect()` call on a line by itself; that threw
// an ordinary uncaught JS Error ("Link annotations have no Rect property"), which Node's default
// uncaught-exception handler printed using the offending source file's content (mupdf-wasm.js is
// a single very long minified line, so Node's snippet looked like a dump of the whole bundle).
// That was misread as a WASM RuntimeError abort. It was not — it was a normal catchable
// exception from an unwrapped call, one line before the put() the doc blamed. See the findings
// doc's Q1 section and this task's fix report for the correction.
//
// Run with:
//   export PATH=/opt/homebrew/bin:$PATH
//   pnpm tsx spikes/09-link-rect-abort.ts
import * as mupdf from 'mupdf'
import { readFileSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

const doc = mupdf.Document.openDocument(
  new Uint8Array(readFileSync(fixturePath('simple-text'))),
  'application/pdf',
) as mupdf.PDFDocument
const page = doc.loadPage(0) as mupdf.PDFPage

console.log('--- Part 1: high-level setRect() on a Link annotation (catchable) ---')
const link = page.createAnnotation('Link')
console.log('hasRect():', link.hasRect())
try {
  console.log('getRect() (before any set):', link.getRect())
} catch (e) {
  console.log('getRect() FAILED:', (e as Error).message)
}
try {
  link.setRect([72, 300, 300, 320])
  console.log('setRect() succeeded (unexpected)')
} catch (e) {
  console.log('setRect() FAILED (expected):', (e as Error).message)
}

console.log('\n--- Part 2: low-level escape hatch — getObject().put("Rect", ...) ---')
try {
  link.getObject().put('Rect', [72, 300, 300, 320])
  console.log('put("Rect", ...) succeeded, no crash')
} catch (e) {
  console.log('put("Rect", ...) FAILED:', (e as Error).message)
}
try {
  console.log('getRect() after manual put:', link.getRect())
} catch (e) {
  console.log('getRect() after manual put FAILED:', (e as Error).message)
}
try {
  const changed = link.update()
  console.log('update() after manual put returned:', changed)
  console.log('/AP after update():', link.getObject().get('AP').isNull() ? 'NULL' : 'present')
} catch (e) {
  console.log('update() after manual put FAILED:', (e as Error).message)
}
console.log('\n--- Part 3: the ORIGINAL (unwrapped) call, to reproduce what actually happened ---')
console.log('Calling link2.getRect() with NO try/catch, matching the deleted ad-hoc probe exactly.')
console.log('If this crashes the process, that reproduces the original observation faithfully.')
const link2 = page.createAnnotation('Link')
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
;(link2 as unknown as { getRect: () => unknown }).getRect()
console.log('link2.getRect() returned without throwing (would be a surprise)')
