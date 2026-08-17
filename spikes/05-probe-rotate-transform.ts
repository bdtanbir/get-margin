import * as mupdf from 'mupdf'
import { readFileSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

const doc = mupdf.Document.openDocument(new Uint8Array(readFileSync(fixturePath('rotated'))), 'application/pdf') as mupdf.PDFDocument
for (let i = 0; i < 4; i++) {
  const page = doc.loadPage(i) as mupdf.PDFPage
  const obj = page.getObject()
  const rotateRaw = obj.get('Rotate')
  console.log(`page ${i}: /Rotate dict entry =`, rotateRaw?.toString(), ' getTransform() =', page.getTransform(), ' getBounds() =', page.getBounds())
}
