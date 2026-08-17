import * as mupdf from 'mupdf'
import { readFileSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

const doc = mupdf.Document.openDocument(new Uint8Array(readFileSync(fixturePath('offset-cropbox'))), 'application/pdf') as mupdf.PDFDocument
const page = doc.loadPage(0) as mupdf.PDFPage
const obj = page.getObject()
console.log('raw page dict:', obj.toString())
console.log('CropBox raw:', obj.get('CropBox')?.toString())
console.log('MediaBox raw:', obj.get('MediaBox')?.toString())
console.log('getBounds() default:', page.getBounds())
console.log('getBounds("CropBox"):', page.getBounds('CropBox'))
console.log('getBounds("MediaBox"):', page.getBounds('MediaBox'))

const pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true)
console.log('\npixmap for offset-cropbox at Matrix.identity:', pix.getWidth(), 'x', pix.getHeight())
console.log('(if this equals CropBox-normalized dims 400x500, toPixmap renders in cropbox-relative space, not raw 612x792 MediaBox space)')
