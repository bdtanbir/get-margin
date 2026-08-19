import { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFString } from 'pdf-lib'
import { writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  const finalPath = join(outDir, `${name}.pdf`)
  // Multiple test files each call generateFixtures() in their own beforeAll and
  // vitest runs them concurrently — write-then-rename so a reader never observes
  // a torn/partial file mid-write from a sibling generator run.
  const tmpPath = join(outDir, `.${name}.pdf.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`)
  await writeFile(tmpPath, bytes)
  await rename(tmpPath, finalPath)
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

/**
 * A document carrying scripted actions, for the sanitiser's tests.
 *
 * GENERATED, not committed: a genuinely malicious PDF sitting in the
 * repository is a hazard to whoever clones it. Everything here is inert on
 * its own -- `app.alert` does nothing outside a JavaScript-enabled viewer --
 * but it is exactly the shape the stripper must recognise.
 */
async function hostile(outDir: string): Promise<void> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('Hostile fixture', { x: 60, y: 700, size: 24, font, color: rgb(0, 0, 0) })

  const ctx = doc.context
  const script = (code: string) =>
    ctx.register(
      ctx.obj({ S: PDFName.of('JavaScript'), JS: PDFString.of(code) }),
    )

  // Runs when the document opens.
  doc.catalog.set(PDFName.of('OpenAction'), script('app.alert("on-open")'))

  // Document-level scripts, via the name tree.
  const tree = ctx.obj({
    Names: [PDFString.of('evil'), script('this.exportDataObject()')],
  })
  doc.catalog.set(PDFName.of('Names'), ctx.register(ctx.obj({ JavaScript: ctx.register(tree) })))

  // Catalog additional actions (will-close).
  doc.catalog.set(
    PDFName.of('AA'),
    ctx.register(ctx.obj({ WC: script('app.alert("on-close")') })),
  )

  // Page additional actions (page-open).
  page.node.set(
    PDFName.of('AA'),
    ctx.register(ctx.obj({ O: script('app.alert("on-page-open")') })),
  )

  await save(doc, outDir, 'hostile')
}

/**
 * A realistic AcroForm: a text field, a checkbox, a three-button radio
 * group, and a dropdown.
 *
 * Built with pdf-lib's form API rather than raw objects, deliberately. The
 * point of a fixture is to be a document someone else made -- generating it
 * with the same code the write path uses would let a shared misunderstanding
 * pass every test on both sides.
 */
async function form(outDir: string): Promise<void> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('Application form', { x: 60, y: 720, size: 20, font, color: rgb(0, 0, 0) })

  const acro = doc.getForm()

  page.drawText('Full name', { x: 60, y: 660, size: 11, font })
  const name = acro.createTextField('fullname')
  name.addToPage(page, { x: 60, y: 630, width: 300, height: 22 })

  page.drawText('Notes', { x: 60, y: 590, size: 11, font })
  const notes = acro.createTextField('notes')
  notes.enableMultiline()
  notes.addToPage(page, { x: 60, y: 520, width: 300, height: 60 })

  const agree = acro.createCheckBox('agree')
  agree.addToPage(page, { x: 60, y: 480, width: 16, height: 16 })
  page.drawText('I agree to the terms', { x: 84, y: 483, size: 11, font })

  page.drawText('Contact me by', { x: 60, y: 440, size: 11, font })
  const contact = acro.createRadioGroup('contact')
  const labels = ['Email', 'Phone', 'Post']
  labels.forEach((label, i) => {
    contact.addOptionToPage(label, page, { x: 60, y: 410 - i * 24, width: 14, height: 14 })
    page.drawText(label, { x: 82, y: 411 - i * 24, size: 11, font })
  })

  page.drawText('Country', { x: 60, y: 320, size: 11, font })
  const country = acro.createDropdown('country')
  country.addOptions(['Bangladesh', 'Canada', 'Denmark'])
  country.addToPage(page, { x: 60, y: 290, width: 200, height: 22 })

  await save(doc, outDir, 'form')
}

export async function generateFixtures(outDir = fileURLToPath(new URL('.', import.meta.url))): Promise<void> {
  await mkdir(outDir, { recursive: true })
  await simpleText(outDir)
  await rotated(outDir)
  await offsetCropBox(outDir)
  await multiPage(outDir)
  await large300p(outDir)
  await mixedFonts(outDir)
  await hostile(outDir)
  await form(outDir)
}
