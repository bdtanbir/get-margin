import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

// Q1: does mupdf.js expose raw object manipulation on PDFDocument?
const RAW = [
  'newDictionary', 'newArray', 'newName', 'newString', 'newInteger', 'newReal',
  'newBoolean', 'newNull', 'addObject', 'addStream', 'addRawStream', 'getTrailer',
]

const bytes = new Uint8Array(readFileSync(fixturePath('simple-text')))
const doc = mupdf.Document.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument

console.log('--- Q1: raw object API on PDFDocument ---')
for (const m of RAW) {
  console.log(`  ${m}: ${typeof (doc as unknown as Record<string, unknown>)[m]}`)
}
// PDFObject instance methods (need an object to introspect from)
const probeObj = doc.newDictionary()
console.log('--- Q1: PDFObject instance methods ---')
for (const m of ['get', 'put', 'delete', 'push', 'isNull', 'isArray', 'isDictionary', 'isStream', 'isName', 'isNumber', 'asJS']) {
  console.log(`  ${m}: ${typeof (probeObj as unknown as Record<string, unknown>)[m]}`)
}

const page = doc.loadPage(0) as mupdf.PDFPage

try {
  // Q4 (pristine doc): getWidgets() call shape on a fixture with no form fields.
  const widgetsBefore = page.getWidgets()
  console.log(`\n--- Q4 (pristine fixture) ---`)
  console.log(`getWidgets() -> ${widgetsBefore.length} widgets (expected 0 — fixture has no AcroForm)`)

  // Q2: assemble a text field from scratch.
  console.log('\n--- Q2: assembling /Tx field from scratch ---')
  const annot = page.createAnnotation('Widget')
  // engine-facts: setRect takes page-space, top-down coords, same as everywhere else.
  annot.setRect([72, 500, 320, 524])

  const fieldObj = annot.getObject()
  fieldObj.put('FT', doc.newName('Tx'))
  fieldObj.put('T', doc.newString('probe_text_field'))
  fieldObj.put('Ff', doc.newInteger(0)) // no flags: single-line, not required
  fieldObj.put('V', doc.newString('hello'))
  fieldObj.put('DA', doc.newString('/Helv 12 Tf 0 g'))
  annot.update()
  console.log('Tx field dict assembled + annot.update() called')
  console.log('  AP after update():', fieldObj.get('AP').isNull() ? 'NULL — no auto appearance for Tx' : 'present')

  // A second field: checkbox (/Btn), to see how much harder a second field type is.
  console.log('\n--- Q2 extra: assembling /Btn checkbox from scratch ---')
  const cbAnnot = page.createAnnotation('Widget')
  cbAnnot.setRect([72, 460, 90, 478])
  const cbObj = cbAnnot.getObject()
  cbObj.put('FT', doc.newName('Btn'))
  cbObj.put('T', doc.newString('probe_checkbox'))
  cbObj.put('Ff', doc.newInteger(0))
  cbObj.put('V', doc.newName('Off'))
  cbObj.put('AS', doc.newName('Off'))
  cbAnnot.update()
  console.log('Btn checkbox dict assembled + annot.update() called')
  console.log('  AP after update():', cbObj.get('AP').isNull() ? 'NULL — no auto appearance for Btn' : 'present')

  // A third field: combo box (/Ch), to exercise Opt/options.
  console.log('\n--- Q2 extra: assembling /Ch combo box from scratch ---')
  const chAnnot = page.createAnnotation('Widget')
  chAnnot.setRect([72, 420, 220, 442])
  const chObj = chAnnot.getObject()
  chObj.put('FT', doc.newName('Ch'))
  chObj.put('T', doc.newString('probe_combo'))
  chObj.put('Ff', doc.newInteger(1 << 17)) // Combo flag (bit 18, 0-indexed 17)
  const opts = doc.newArray()
  opts.push(doc.newString('Alpha'))
  opts.push(doc.newString('Beta'))
  opts.push(doc.newString('Gamma'))
  chObj.put('Opt', opts)
  chObj.put('V', doc.newString('Alpha'))
  chObj.put('DA', doc.newString('/Helv 12 Tf 0 g'))
  chAnnot.update()
  console.log('Ch combo dict assembled + annot.update() called')
  console.log('  AP after update():', chObj.get('AP').isNull() ? 'NULL — no auto appearance for Ch' : 'present')

  // Q2: wire the document /AcroForm.
  console.log('\n--- Q2: wiring /AcroForm ---')
  const trailer = doc.getTrailer()
  const root = trailer.get('Root')
  let acro = root.get('AcroForm')
  // engine-facts: get() never returns undefined — a missing key has isNull() === true.
  if (acro.isNull()) {
    acro = doc.newDictionary()
    root.put('AcroForm', acro)
    console.log('created /AcroForm (was absent — isNull() caught it correctly)')
  } else {
    console.log('/AcroForm already present (unexpected for this fixture)')
  }

  const fields = doc.newArray()
  fields.push(fieldObj)
  fields.push(cbObj)
  fields.push(chObj)
  acro.put('Fields', fields)
  acro.put('DA', doc.newString('/Helv 12 Tf 0 g'))
  acro.put('NeedAppearances', doc.newBoolean(true))
  console.log('AcroForm wired: /Fields (3 fields), /DA, /NeedAppearances')

  // /DR default resources — without a Helv font resource, viewers can't render field text.
  const dr = doc.newDictionary()
  const fonts = doc.newDictionary()
  const helv = doc.newDictionary()
  helv.put('Type', doc.newName('Font'))
  helv.put('Subtype', doc.newName('Type1'))
  helv.put('BaseFont', doc.newName('Helvetica'))
  helv.put('Encoding', doc.newName('WinAnsiEncoding'))
  fonts.put('Helv', helv)
  dr.put('Font', fonts)
  acro.put('DR', dr)
  console.log('/DR default resources added')

  // Structural verification — dump what actually got written, not just "it didn't throw".
  console.log('\n--- Structural verification (programmatic) ---')
  const acroCheck = root.get('AcroForm')
  console.log('root.get(AcroForm).isNull():', acroCheck.isNull())
  const fieldsCheck = acroCheck.get('Fields')
  console.log('AcroForm.Fields.isArray():', fieldsCheck.isArray(), 'length:', fieldsCheck.length)
  console.log('AcroForm.DR.isDictionary():', acroCheck.get('DR').isDictionary())
  console.log('AcroForm.DA:', acroCheck.get('DA').asString())
  console.log('field0 FT:', fieldsCheck.get(0).get('FT').asName(), 'T:', fieldsCheck.get(0).get('T').asString())
  console.log('field0 Rect (raw, bottom-up):', fieldsCheck.get(0).get('Rect').asJS())

  writeFileSync('spikes/out-widget.pdf', doc.saveToBuffer('compress').asUint8Array())
  console.log('\nWrote spikes/out-widget.pdf')
} finally {
  page.destroy()
}

// Render our own output with mupdf's toPixmap for visual verification.
console.log('\n--- Rendering out-widget.pdf with mupdf toPixmap ---')
{
  const rdoc = mupdf.Document.openDocument(
    new Uint8Array(readFileSync('spikes/out-widget.pdf')),
    'application/pdf',
  ) as mupdf.PDFDocument
  const rpage = rdoc.loadPage(0) as mupdf.PDFPage
  try {
    const pix = rpage.toPixmap([1.5, 0, 0, 1.5, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true)
    try {
      writeFileSync('spikes/out-widget-mupdf-render.png', pix.asPNG())
      console.log('Wrote spikes/out-widget-mupdf-render.png')
    } finally {
      pix.destroy()
    }

    // Q4 (populated doc): re-enumerate the widgets we just wrote, from a fresh reopened doc.
    console.log('\n--- Q4: getWidgets() on the doc we just created (reopened from disk) ---')
    const widgets = rpage.getWidgets()
    console.log(`getWidgets() -> ${widgets.length} widgets`)
    for (const w of widgets) {
      const type = w.getFieldType()
      console.log(`  [${type}] name=${w.getName()} value=${JSON.stringify(w.getValue())} rect=${JSON.stringify(w.getRect())} readOnly=${w.isReadOnly()}`)
      if (type === 'combobox' || type === 'listbox') {
        console.log(`    options: ${JSON.stringify(w.getOptions())}`)
      }
    }
  } finally {
    rpage.destroy()
  }
  rdoc.destroy()
}

doc.destroy()
console.log('\ndone.')
