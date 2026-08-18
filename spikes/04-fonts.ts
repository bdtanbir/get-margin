import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

const TTF = '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'
const ALT = '/Library/Fonts/Arial Unicode.ttf'
const fontPath = existsSync(TTF) ? TTF : ALT
if (!existsSync(fontPath)) throw new Error(`no TTF at ${TTF} or ${ALT} — point fontPath at any .ttf`)
console.log('Using TTF:', fontPath, `(${(readFileSync(fontPath).length / 1024 / 1024).toFixed(1)}MB)`)

const doc = mupdf.Document.openDocument(
  new Uint8Array(readFileSync(fixturePath('simple-text'))),
  'application/pdf',
) as mupdf.PDFDocument

console.log('\n--- PDFDocument own-prototype methods ---')
console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(doc)).sort().join(', '))
console.log('\n--- mupdf top-level exports ---')
console.log(Object.keys(mupdf).sort().join(', '))

// Q4: construct a Font from raw TTF bytes.
let font: mupdf.Font | undefined
try {
  const bytes = new Uint8Array(readFileSync(fontPath))
  font = new mupdf.Font('ProbeFont', bytes)
  console.log('\nnew mupdf.Font(name, bytes): OK')
  console.log('Font own-prototype methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(font)).sort().join(', '))
  console.log('font.getName():', font.getName())
} catch (e) {
  console.log('\nnew mupdf.Font FAILED:', (e as Error).message)
}

// Q4 continued: register it in the document via each of the three add*Font calls the .d.ts
// exposes (addSimpleFont, addCJKFont, addFont) to see which actually work for an arbitrary
// non-CJK Unicode TTF.
if (font) {
  try {
    const ref = doc.addSimpleFont(font, 'Latin')
    console.log('\naddSimpleFont(font, "Latin"): OK ->', ref.toString())
  } catch (e) {
    console.log('\naddSimpleFont FAILED:', (e as Error).message)
  }

  try {
    const ref2 = doc.addFont(font)
    console.log('addFont(font) [[Identity-H composite, full Unicode]]: OK ->', ref2.toString().slice(0, 200))
  } catch (e) {
    console.log('addFont FAILED:', (e as Error).message)
  }
}

// Q5: size cost. Compare a doc with NO extra font registered vs. one with addFont() called,
// both saved with the same options, to isolate the font's contribribution to file size.
const baselineDoc = mupdf.Document.openDocument(
  new Uint8Array(readFileSync(fixturePath('simple-text'))),
  'application/pdf',
) as mupdf.PDFDocument
const baselineBytes = baselineDoc.saveToBuffer('compress').asUint8Array()
writeFileSync('spikes/out-font-baseline.pdf', baselineBytes)
console.log(`\nbaseline (no font registered) file size: ${(baselineBytes.length / 1024).toFixed(1)}KB`)

const withFontBytes = doc.saveToBuffer('compress').asUint8Array()
writeFileSync('spikes/out-font.pdf', withFontBytes)
console.log(`file size with font registered via addFont(): ${(withFontBytes.length / 1024).toFixed(1)}KB`)

const rawTtfKB = readFileSync(fontPath).length / 1024
console.log(`raw TTF size: ${rawTtfKB.toFixed(1)}KB`)
console.log(`delta (withFont - baseline): ${((withFontBytes.length - baselineBytes.length) / 1024).toFixed(1)}KB`)
console.log(
  'If delta ~= raw TTF size, NO subsetting happens (full font embedded). If delta << raw TTF size, subsetting (or at least deduplication/compression) happened.',
)

// Bonus: does drawing actual text with the registered font (via a content stream / FreeText
// default-appearance font resource) change anything measurable, or is addFont() alone enough
// to embed the whole font regardless of usage? Check doc-level font resource / object count.
console.log('\ncountObjects() baseline:', baselineDoc.countObjects())
console.log('countObjects() with font registered (unused by any content):', doc.countObjects())
