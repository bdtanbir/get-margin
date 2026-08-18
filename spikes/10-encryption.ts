// Task 5 spike: encryption and save options.
//
// mupdf resolved to 1.28.0 (engine-facts.md). `saveToBuffer()` in
// node_modules/mupdf/dist/mupdf.d.ts is typed `options?: string | Record<string, any>` — there
// is NO enumerated options type shipped. The only enumeration available is the runtime
// validation baked into the wasm binary itself, which we extract below with `disposal`-safe
// try/finally around every page/pixmap use per engine-facts.md.
//
// Run with:
//   export PATH=/opt/homebrew/bin:$PATH
//   pnpm tsx spikes/10-encryption.ts 2>&1 | tee docs/findings/scratch/10-enc.log
import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

const src = new Uint8Array(readFileSync(fixturePath('large-300p')))

function open(): mupdf.PDFDocument {
  return mupdf.Document.openDocument(src, 'application/pdf') as mupdf.PDFDocument
}

console.log('=== Q1: saveToBuffer options — probing for validation behaviour ===')
// The wasm binary contains the literal strings "unknown option: %s=%s" and
// "unknown garbage option in options" (found via `strings mupdf-wasm.wasm`), which means
// genuinely bad keys/values should THROW rather than silently no-op. Confirm that directly.
const BAD_OPTIONS = ['not-a-real-option=yes', 'garbage=not-a-real-mode', 'compress=maybe']
for (const o of BAD_OPTIONS) {
  const doc = open()
  try {
    doc.saveToBuffer(o)
    console.log(`"${o}" -> did NOT throw (silently accepted or ignored)`)
  } catch (e) {
    console.log(`"${o}" -> THREW: ${(e as Error).message}`)
  }
}

// Also confirm the Record<string, any> overload documented in the .d.ts actually works
// (mupdf.js's JS wrapper stringifies it internally — see dist/mupdf.js saveToBuffer()).
{
  const doc = open()
  try {
    const out = doc.saveToBuffer({ compress: true }).asUint8Array()
    console.log(`Record form {compress:true} -> saved ${(out.length / 1024).toFixed(0)}KB (no throw)`)
  } catch (e) {
    console.log(`Record form {compress:true} -> THREW: ${(e as Error).message}`)
  }
}

console.log('\n=== Q4: what do save options actually buy? ===')
const OPTS = ['', 'compress', 'garbage=compact', 'garbage=deduplicate', 'compress,garbage=deduplicate']
for (const o of OPTS) {
  const doc = open()
  try {
    const out = doc.saveToBuffer(o).asUint8Array()
    console.log(`"${o}" -> ${(out.length / 1024).toFixed(0)}KB`)
  } catch (e) {
    console.log(`"${o}" FAILED: ${(e as Error).message}`)
  }
}
console.log(`baseline source: ${(src.length / 1024).toFixed(0)}KB`)

console.log('\n=== Q1/Q2: encryption — try every plausible spelling ===')
const CANDIDATES = [
  'encrypt=aes-256,user-password=secret,owner-password=owner',
  'encrypt=aes256,user-password=secret,owner-password=owner',
  'encryption=aes-256,user-password=secret',
  'user-password=secret,owner-password=owner',
  'decrypt=no,user-password=secret',
  'encrypt=rc4-128,user-password=secret,owner-password=owner',
  'encrypt=aes-128,user-password=secret,owner-password=owner,permissions=4',
]
let worked: string | null = null
for (const o of CANDIDATES) {
  const doc = open()
  try {
    const out = doc.saveToBuffer(o).asUint8Array()
    // The real test: can it be reopened WITHOUT the password?
    let needsPw = false
    try {
      const re = mupdf.Document.openDocument(out, 'application/pdf') as mupdf.PDFDocument
      needsPw = re.needsPassword()
    } catch {
      needsPw = true
    }
    console.log(`"${o}" -> saved ${(out.length / 1024).toFixed(0)}KB, needsPassword=${needsPw}`)
    if (needsPw && !worked) {
      worked = o
      writeFileSync('spikes/out-enc.pdf', out)
    }
  } catch (e) {
    console.log(`"${o}" FAILED: ${(e as Error).message}`)
  }
}
console.log('\nENCRYPTION SUPPORTED:', worked ?? 'NO — qpdf-wasm needed')

if (worked) {
  console.log('\n=== Q3: decryption round-trip ===')
  const enc = new Uint8Array(readFileSync('spikes/out-enc.pdf'))
  const d = mupdf.Document.openDocument(enc, 'application/pdf') as mupdf.PDFDocument
  console.log('needsPassword:', d.needsPassword())
  console.log('authenticatePassword("wrong"):', d.authenticatePassword('wrong'))
  console.log('authenticatePassword("secret"):', d.authenticatePassword('secret'))
  console.log('hasPermission("print") after auth (default/full-permission doc):', d.hasPermission('print'))
  console.log('hasPermission("edit") after auth (default/full-permission doc):', d.hasPermission('edit'))

  console.log('\n=== Q3b: permission-flag ENFORCEMENT — does a restrictive permissions= value actually restrict? ===')
  // "out-enc.pdf" above carries no permissions= key, so it's full-access by default: hasPermission()
  // returning true for everything there proves nothing about enforcement (review finding #2).
  // Save a SEPARATE doc with a genuinely restrictive permissions= value, reopen it, authenticate with
  // the USER password (owner auth always gets full access — that's not the enforcement test), and check
  // whether hasPermission() actually reflects the restriction.
  const PERMS: mupdf.DocumentPermission[] = ['print', 'copy', 'edit', 'annotate', 'form', 'accessibility', 'assemble', 'print-hq']
  function checkPermissions(label: string, permissionsValue: number | null) {
    const opt = permissionsValue === null
      ? 'encrypt=aes-256,user-password=secret,owner-password=owner'
      : `encrypt=aes-256,user-password=secret,owner-password=owner,permissions=${permissionsValue}`
    const doc2 = open()
    const out2 = doc2.saveToBuffer(opt).asUint8Array()
    const re2 = mupdf.Document.openDocument(out2, 'application/pdf') as mupdf.PDFDocument
    re2.authenticatePassword('secret') // USER password — owner auth bypasses restrictions entirely
    const results = PERMS.map((p) => `${p}=${re2.hasPermission(p)}`).join(' ')
    console.log(`${label} (permissions=${permissionsValue}): ${results}`)
  }
  checkPermissions('no permissions= key (default)', null)
  checkPermissions('print-only (PDF spec bit 3)', 4)
  checkPermissions('explicit full access (matches default /P -4 seen in Q2)', -4)
  checkPermissions('print+print-hq+copy+edit+annotate, no form/accessibility/assemble', 2048 + 32 + 16 + 8 + 4)

  let plain: Uint8Array
  try {
    plain = d.saveToBuffer('decrypt=yes,compress').asUint8Array()
    console.log('re-saved with decrypt=yes,compress')
  } catch (e) {
    console.log('decrypt=yes FAILED, falling back to bare "compress":', (e as Error).message)
    plain = d.saveToBuffer('compress').asUint8Array()
  }
  writeFileSync('spikes/out-dec.pdf', plain)
  const reopened = mupdf.Document.openDocument(plain, 'application/pdf') as mupdf.PDFDocument
  console.log('decrypted copy needsPassword:', reopened.needsPassword(), '(want false)')

  console.log('\n=== Independent (non-MuPDF) confirmation of Q2 ===')
  console.log('spikes/out-enc.pdf size on disk:', statSync('spikes/out-enc.pdf').size, 'bytes')
  console.log('spikes/out-dec.pdf size on disk:', statSync('spikes/out-dec.pdf').size, 'bytes')
  console.log('Run the companion script for the actual non-MuPDF checks (strings + qlmanage), it is a')
  console.log('separate committed file (spikes/10-verify.sh) rather than inline here because those are')
  console.log('shell/macOS tools, not something to shell out to from inside the tsx process:')
  console.log('  bash spikes/10-verify.sh')
}
