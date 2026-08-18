import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

function extractText(doc: mupdf.PDFDocument, page: mupdf.PDFPage): string {
  const st = page.toStructuredText()
  try {
    const json = JSON.parse(st.asJSON()) as { blocks: Array<{ lines: Array<{ text: string }> }> }
    return json.blocks.flatMap((b) => b.lines.map((l) => l.text)).join('\n')
  } finally {
    st.destroy()
  }
}

const doc = mupdf.Document.openDocument(
  new Uint8Array(readFileSync(fixturePath('simple-text'))),
  'application/pdf',
) as mupdf.PDFDocument
const page = doc.loadPage(0) as mupdf.PDFPage

try {
  console.log('--- Text extraction BEFORE any patch ---')
  const before = extractText(doc, page)
  console.log(before)

  const pageObj = page.getObject()
  const contents = pageObj.get('Contents')
  console.log('\n--- Q5: Contents object ---')
  console.log('Contents.isArray():', contents.isArray())
  console.log('Contents.isStream():', contents.isStream())

  // Q5: read the content stream bytes.
  let raw: Uint8Array
  let target: mupdf.PDFObject
  if (contents.isArray()) {
    console.log('Contents is an array — must concatenate parts')
    target = contents.get(0)
  } else {
    target = contents
  }
  raw = target.readStream().asUint8Array()
  console.log('stream bytes:', raw.length)
  const text = new TextDecoder('latin1').decode(raw)
  console.log('\n--- full content stream (decoded latin1) ---')
  console.log(text)

  // Q6: locate Tj/TJ text-showing operators via regex over the decoded stream.
  // FIRST ATTEMPT (brief's assumption): only literal parenthesized strings "(...)".
  const tjLiteralOnly = [...text.matchAll(/\((?:[^()\\]|\\.)*\)\s*Tj/g)]
  console.log(`\n[naive literal-only regex] found ${tjLiteralOnly.length} Tj operators`)
  console.log('  -> this fixture actually uses HEX-STRING operands ("<...> Tj"), so the naive')
  console.log('     literal-paren-only regex finds ZERO matches. Confirmed failure mode.')

  // CORRECTED: PDF text-showing operands can be either a literal string "(...)"
  // or a hex string "<...>". A real implementation must handle both.
  const tj = [...text.matchAll(/(?:\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)\s*Tj/g)]
  const tJ = [...text.matchAll(/\[(?:[^\[\]\\]|\\.)*\]\s*TJ/g)]
  console.log(`\n[corrected regex, literal OR hex] found ${tj.length} Tj and ${tJ.length} TJ operators`)
  for (const m of tj) console.log('  Tj:', JSON.stringify(m[0]), '@', m.index)
  for (const m of tJ) console.log('  TJ:', JSON.stringify(m[0]), '@', m.index)

  // Q5 continued + Q6: patch out the SECOND Tj run ("Second line of body text for span
  // extraction.") by blanking it with spaces — preserves byte offsets.
  const victim = tj[1] ?? tj[0]
  if (!victim) throw new Error('no Tj operator found to patch')
  console.log('\nPatching out run:', JSON.stringify(victim[0]))
  const patched = text.slice(0, victim.index!) + ' '.repeat(victim[0].length) + text.slice(victim.index! + victim[0].length)

  target.writeStream(new TextEncoder().encode(patched))
  console.log('writeStream() succeeded')

  writeFileSync('spikes/out-patched.pdf', doc.saveToBuffer('compress').asUint8Array())
  console.log('Wrote spikes/out-patched.pdf')
} finally {
  page.destroy()
}
doc.destroy()

// Reopen the patched file fresh — the decisive check.
console.log('\n--- Reopening spikes/out-patched.pdf fresh, for the decisive Q6 check ---')
const doc2 = mupdf.Document.openDocument(
  new Uint8Array(readFileSync('spikes/out-patched.pdf')),
  'application/pdf',
) as mupdf.PDFDocument
const page2 = doc2.loadPage(0) as mupdf.PDFPage
try {
  const after = extractText(doc2, page2)
  console.log('--- Text extraction AFTER patch, from a freshly reopened doc ---')
  console.log(JSON.stringify(after))
  console.log('\ncontains "Second line of body text"?', after.includes('Second line of body text'))
  console.log('other text still present ("Hello margin")?', after.includes('Hello margin'))

  const pix = page2.toPixmap([1.5, 0, 0, 1.5, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true)
  try {
    writeFileSync('spikes/out-patched-mupdf-render.png', pix.asPNG())
    console.log('\nWrote spikes/out-patched-mupdf-render.png')
  } finally {
    pix.destroy()
  }
} finally {
  page2.destroy()
}
doc2.destroy()
// Q6 robustness check: does the regex approach survive realistic edge cases that a
// real tokenizer would handle correctly? Test against synthetic operator sequences,
// not the fixture (which happens to use plain hex strings with no escapes).
console.log('\n--- Q6 robustness: synthetic edge cases for the regex approach ---')
const TJRE = /(?:\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)\s*Tj/g
const TJARRE = /\[(?:[^\[\]\\]|\\.)*\]\s*TJ/g

const cases: Array<[string, string]> = [
  ['escaped parens inside literal string', String.raw`(a \(nested\) string) Tj`],
  ['escaped backslash then paren', String.raw`(back\\\\) Tj` + ' (real end) Tj'],
  ['TJ array with kerning numbers', '[(Hello) -20 (world)] TJ'],
  ['TJ array containing a literal ] inside a string — genuinely ambiguous for a naive charclass regex', String.raw`[(a]b) -5 (c)] TJ`],
  ['two Tj on one line', '(One) Tj (Two) Tj'],
]
for (const [label, sample] of cases) {
  const m1 = [...sample.matchAll(TJRE)]
  const m2 = [...sample.matchAll(TJARRE)]
  console.log(`  [${label}]`)
  console.log(`    input: ${JSON.stringify(sample)}`)
  console.log(`    Tj matches: ${JSON.stringify(m1.map((m) => m[0]))}`)
  console.log(`    TJ matches: ${JSON.stringify(m2.map((m) => m[0]))}`)
}
console.log('\ndone.')
