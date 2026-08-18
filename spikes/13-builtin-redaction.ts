import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

// Bonus probe, not in the brief: mupdf.d.ts exposes PDFPage.applyRedactions() and a
// 'Redact' PDFAnnotationType with REDACT_TEXT_REMOVE/NONE constants. If this actually
// strips the underlying text (not just paints a black box), it changes the Phase 6
// estimate significantly — a built-in primitive beats hand-rolled content-stream surgery.

function extractText(page: mupdf.PDFPage): string {
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
  console.log('before:', JSON.stringify(extractText(page)))

  const annot = page.createAnnotation('Redact')
  console.log('createAnnotation(Redact) OK')
  console.log('hasRect():', annot.hasRect(), 'hasQuadPoints():', annot.hasQuadPoints())

  // FIRST ATTEMPT used the raw content-stream Tm y-value (660) directly as a page-space
  // coordinate — WRONG. That Tm is in raw bottom-up PDF space; annotation setters take
  // page-space top-down coords (per engine-facts). Confirmed by rendering: the black box
  // landed near the BOTTOM of the page while the real text is near the TOP. Corrected
  // below using the bbox measured from toStructuredText().asJSON(), which IS page-space:
  // "Second line..." -> {x:72, y:120, w:214, h:15}.
  annot.setRect([70, 118, 290, 137])
  // hasQuadPoints() is true for Redact — applyRedactions keys off QuadPoints, not Rect
  // alone (first attempt with only setRect left the text untouched — see log/history).
  annot.setQuadPoints([[70, 118, 290, 118, 70, 137, 290, 137]])
  annot.update()
  console.log('Redact annot placed (Rect + QuadPoints) + update() called')

  console.log('\napplyRedactions constants:', {
    IMAGE_NONE: mupdf.PDFPage.REDACT_IMAGE_NONE,
    IMAGE_REMOVE: mupdf.PDFPage.REDACT_IMAGE_REMOVE,
    TEXT_REMOVE: mupdf.PDFPage.REDACT_TEXT_REMOVE,
    TEXT_NONE: mupdf.PDFPage.REDACT_TEXT_NONE,
  })

  page.applyRedactions(true, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE)
  console.log('applyRedactions() called with black_boxes=true, text_method=REDACT_TEXT_REMOVE')

  console.log('\nafter (same live page object):', JSON.stringify(extractText(page)))

  writeFileSync('spikes/out-builtin-redact.pdf', doc.saveToBuffer('compress').asUint8Array())
  console.log('Wrote spikes/out-builtin-redact.pdf')
} finally {
  page.destroy()
}
doc.destroy()

// Decisive check: reopen fresh and re-extract + render.
console.log('\n--- reopening fresh ---')
const doc2 = mupdf.Document.openDocument(
  new Uint8Array(readFileSync('spikes/out-builtin-redact.pdf')),
  'application/pdf',
) as mupdf.PDFDocument
const page2 = doc2.loadPage(0) as mupdf.PDFPage
try {
  const text = extractText(page2)
  console.log('extracted text from fresh reopen:', JSON.stringify(text))
  console.log('contains "Second line of body text"?', text.includes('Second line of body text'))
  console.log('other text still present ("Hello margin")?', text.includes('Hello margin'))

  const pix = page2.toPixmap([1.5, 0, 0, 1.5, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true)
  try {
    writeFileSync('spikes/out-builtin-redact-render.png', pix.asPNG())
    console.log('Wrote spikes/out-builtin-redact-render.png')
  } finally {
    pix.destroy()
  }
} finally {
  page2.destroy()
}
doc2.destroy()
console.log('\ndone.')
