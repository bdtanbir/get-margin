// Restores evidence for Q5 in docs/findings/02-write-path.md — the committed 04-fonts.ts calls
// addSimpleFont() AND addFont() on the SAME document sequentially, so it only ever measured a
// combined delta. This isolates each add*Font call on its own document, at two font sizes, and
// tests subsetFonts() three separate ways against a registered-but-unused font.
import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

const fixtureBytes = () => new Uint8Array(readFileSync(fixturePath('simple-text')))

function sizeKB(doc: mupdf.PDFDocument): string {
  return (doc.saveToBuffer('compress').asUint8Array().length / 1024).toFixed(1)
}

function run(label: string, ttfPath: string) {
  console.log(`\n--- ${label}: ${ttfPath} ---`)
  const ttfBytes = new Uint8Array(readFileSync(ttfPath))
  console.log('raw TTF:', (ttfBytes.length / 1024).toFixed(1), 'KB')

  const docA = mupdf.Document.openDocument(fixtureBytes(), 'application/pdf') as mupdf.PDFDocument
  console.log('A) baseline, no font registered:', sizeKB(docA), 'KB')

  const docB = mupdf.Document.openDocument(fixtureBytes(), 'application/pdf') as mupdf.PDFDocument
  const fontB = new mupdf.Font('ProbeFont', ttfBytes)
  docB.addSimpleFont(fontB, 'Latin')
  console.log('B) addSimpleFont ONLY, unused:', sizeKB(docB), 'KB')

  const docC = mupdf.Document.openDocument(fixtureBytes(), 'application/pdf') as mupdf.PDFDocument
  const fontC = new mupdf.Font('ProbeFont', ttfBytes)
  docC.addFont(fontC)
  console.log('C) addFont ONLY, unused:', sizeKB(docC), 'KB')

  const docD = mupdf.Document.openDocument(fixtureBytes(), 'application/pdf') as mupdf.PDFDocument
  const fontD = new mupdf.Font('ProbeFont', ttfBytes)
  docD.addFont(fontD)
  docD.subsetFonts()
  console.log('D) addFont + subsetFonts(), unused:', sizeKB(docD), 'KB')

  const docE = mupdf.Document.openDocument(fixtureBytes(), 'application/pdf') as mupdf.PDFDocument
  const fontE = new mupdf.Font('ProbeFont', ttfBytes)
  const refE = docE.addFont(fontE)
  console.log('E) font ref before subsetFonts():', refE.toString().slice(0, 80))
  docE.subsetFonts()
  console.log('E) addFont (ref captured) + subsetFonts(), unused:', sizeKB(docE), 'KB')

  return { rawKB: ttfBytes.length / 1024, baselineKB: parseFloat(sizeKB(docA)), addFontKB: parseFloat(sizeKB(docC)) }
}

const big = run('Arial Unicode.ttf (large, multi-script)', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf')
const small = run('Arial.ttf (typical single-script)', '/System/Library/Fonts/Supplemental/Arial.ttf')

console.log('\n--- Summary (for the Q5 table) ---')
for (const [name, r] of [
  ['Arial Unicode.ttf', big],
  ['Arial.ttf', small],
] as const) {
  const delta = r.addFontKB - r.baselineKB
  console.log(`${name}: raw=${r.rawKB.toFixed(1)}KB baseline=${r.baselineKB}KB withFont=${r.addFontKB}KB delta=${delta.toFixed(1)}KB (${((delta / r.rawKB) * 100).toFixed(1)}% of raw)`)
}
