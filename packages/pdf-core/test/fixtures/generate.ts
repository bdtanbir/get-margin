import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const FIXED_DATE = new Date('2020-01-01T00:00:00Z')

/** pdf-lib stamps timestamps by default; pinning them is what makes fixtures reproducible. */
function pin(doc: PDFDocument): void {
  doc.setCreationDate(FIXED_DATE)
  doc.setModificationDate(FIXED_DATE)
  doc.setProducer('get-margin-fixtures')
  doc.setCreator('get-margin-fixtures')
}

async function save(doc: PDFDocument, outDir: string, name: string): Promise<void> {
  pin(doc)
  // useObjectStreams:false keeps output stable and human-inspectable in a hex editor.
  const bytes = await doc.save({ useObjectStreams: false })
  await writeFile(join(outDir, `${name}.pdf`), bytes)
}

async function simpleText(outDir: string): Promise<void> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([612, 792]) // US Letter
  page.drawText('Hello margin', { x: 72, y: 700, size: 24, font, color: rgb(0, 0, 0) })
  page.drawText('Second line of body text for span extraction.', {
    x: 72, y: 660, size: 11, font, color: rgb(0.2, 0.2, 0.2),
  })
  page.drawRectangle({ x: 72, y: 600, width: 200, height: 40, color: rgb(0.9, 0.9, 0.95) })
  await save(doc, outDir, 'simple-text')
}

async function rotated(outDir: string): Promise<void> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  // One page per rotation value, so transform tests can assert all four in one document.
  for (const deg of [0, 90, 180, 270]) {
    const page = doc.addPage([612, 792])
    page.setRotation(degrees(deg))
    page.drawText(`rotate ${deg}`, { x: 72, y: 720, size: 18, font })
    // A marker at the PDF-space origin corner — the anchor transform tests assert against.
    page.drawRectangle({ x: 0, y: 0, width: 40, height: 20, color: rgb(1, 0, 0) })
  }
  await save(doc, outDir, 'rotated')
}

async function offsetCropBox(outDir: string): Promise<void> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([612, 792])
  page.drawText('cropbox offset', { x: 100, y: 700, size: 18, font })
  // Non-zero origin AND smaller than MediaBox — the case that breaks naive coordinate code.
  // pdf-lib takes (x, y, width, height) but PDF stores [x0, y0, x1, y1], so these args produce the raw rect [50, 80, 400, 500].
  page.setCropBox(50, 80, 350, 420)
  await save(doc, outDir, 'offset-cropbox')
}

async function multiPage(outDir: string): Promise<void> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 12; i++) {
    const page = doc.addPage([612, 792])
    page.drawText(`Page ${i}`, { x: 72, y: 700, size: 32, font })
  }
  await save(doc, outDir, 'multi-page')
}

async function large300p(outDir: string): Promise<void> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 300; i++) {
    const page = doc.addPage([612, 792])
    page.drawText(`Page ${i} of 300`, { x: 72, y: 720, size: 14, font })
    // Enough text per page that render timing reflects real work, not a blank-page fast path.
    for (let line = 0; line < 40; line++) {
      page.drawText(
        `Line ${line}: the quick brown fox jumps over the lazy dog 0123456789`,
        { x: 72, y: 690 - line * 16, size: 10, font },
      )
    }
  }
  await save(doc, outDir, 'large-300p')
}

async function mixedFonts(outDir: string): Promise<void> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const faces = [
    StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique,
    StandardFonts.TimesRoman, StandardFonts.TimesRomanItalic, StandardFonts.Courier,
  ]
  let y = 720
  for (const face of faces) {
    const font = await doc.embedFont(face)
    page.drawText(`${face} sample text 123`, { x: 72, y, size: 14, font })
    y -= 30
  }
  await save(doc, outDir, 'mixed-fonts')
}

export async function generateFixtures(outDir = new URL('.', import.meta.url).pathname): Promise<void> {
  await mkdir(outDir, { recursive: true })
  await simpleText(outDir)
  await rotated(outDir)
  await offsetCropBox(outDir)
  await multiPage(outDir)
  await large300p(outDir)
  await mixedFonts(outDir)
}
