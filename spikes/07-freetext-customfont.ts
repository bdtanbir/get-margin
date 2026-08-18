// Restores evidence for the Q3 claim in docs/findings/02-write-path.md: FreeText's
// setDefaultAppearance() accepts an arbitrary font-resource-name string but does not build the
// /DR dictionary needed to resolve it, so mupdf's own appearance generator silently falls back
// to a standard font.
import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

const doc = mupdf.Document.openDocument(
  new Uint8Array(readFileSync(fixturePath('simple-text'))),
  'application/pdf',
) as mupdf.PDFDocument
const page = doc.loadPage(0) as mupdf.PDFPage

// Zapfino is chosen because its glyphs are visually unmistakable — if the appearance actually
// used it, it would be obvious in a render; if it silently fell back to Helv, that's also
// obvious.
const fontBytes = new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Zapfino.ttf'))
const font = new mupdf.Font('Zapfino', fontBytes)
const ref = doc.addSimpleFont(font, 'Latin')
console.log('addSimpleFont ref:', ref.toString().slice(0, 120))
console.log('BaseFont entry:', ref.get('BaseFont').asJS())
const resourceName = ref.get('BaseFont').asJS() as string

const ft = page.createAnnotation('FreeText')
ft.setRect([72, 500, 500, 560])
ft.setContents('Zapfino custom-font probe')
try {
  ft.setDefaultAppearance(resourceName, 20, [0, 0, 0])
  ft.update()
  console.log('setDefaultAppearance(customFontBaseFontName) accepted, no throw')
} catch (e) {
  console.log('setDefaultAppearance(customFontName) FAILED:', (e as Error).message)
}
console.log('FreeText /DA:', ft.getObject().get('DA').asJS())
console.log('FreeText /DR present:', !ft.getObject().get('DR').isNull())
console.log('FreeText getDefaultAppearance():', ft.getDefaultAppearance())

writeFileSync('spikes/out-freetext-customfont.pdf', doc.saveToBuffer('compress').asUint8Array())
console.log('wrote spikes/out-freetext-customfont.pdf')
