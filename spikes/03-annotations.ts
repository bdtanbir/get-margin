import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

const doc = mupdf.Document.openDocument(
  new Uint8Array(readFileSync(fixturePath('simple-text'))),
  'application/pdf',
) as mupdf.PDFDocument
const page = doc.loadPage(0) as mupdf.PDFPage

console.log('--- PDFPage own-prototype methods ---')
console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(page)).sort().join(', '))

console.log('\n--- PDFAnnotation.ANNOT_TYPES (from class, ground truth) ---')
console.log((mupdf as unknown as { PDFAnnotation: { ANNOT_TYPES: string[] } }).PDFAnnotation.ANNOT_TYPES.join(', '))

function apPresent(annot: mupdf.PDFAnnotation): string {
  const dict = annot.getObject()
  const ap = dict.get('AP')
  if (ap.isNull()) return 'NO (AP is null)'
  return `YES (isDictionary=${ap.isDictionary()}, toString=${ap.toString().slice(0, 80)})`
}

const TYPES: mupdf.PDFAnnotationType[] = [
  'Highlight',
  'Underline',
  'StrikeOut',
  'Ink',
  'FreeText',
  'Square',
  'Circle',
  'Line',
  'Link',
  'Stamp',
]

console.log('\n--- Q1/Q2: createAnnotation + minimal props + update() + /AP check ---')
for (const type of TYPES) {
  try {
    const a = page.createAnnotation(type)
    console.log(`\n${type}: createAnnotation OK`)
    if (type === 'Highlight') {
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(a)).sort()
      console.log('  annot own-prototype methods:', methods.join(', '))
    }

    // Give each type the minimal geometry/props it needs, then update() and check /AP.
    // NOTE: each type gets its own non-overlapping vertical band so the rendered output is
    // unambiguous — an earlier version of this probe reused one quad for
    // Highlight/Underline/StrikeOut and the three appearance streams stacked into an
    // uninterpretable blob.
    //
    // MAJOR FINDING (measured, see docs/findings/02-write-path.md Q1/Q2): setRect() /
    // setQuadPoints() / setLine() / getRect() operate in PAGE SPACE (top-down, y=0 at the top
    // of the CropBox — same convention as toPixmap/getBounds/getTransform/StructuredText),
    // NOT the raw bottom-up PDF content-stream space the underlying /Rect dict entry actually
    // stores on disk. Verified: setRect([72,400,200,460]) -> getRect() returns the same
    // [72,400,200,460] (round-trips through save/reload), but getObject().get('Rect').asJS()
    // (the literal on-disk dict value) is [71,331,201,393] — the y-flip (792 - y, +/-1pt
    // border inflation) already applied by mupdf's binding. So the "y" values below are
    // page-space/top-down despite reading like naive bottom-up PDF coordinates; they were
    // chosen empirically (via pixel-sampling the rendered PNG) to fall in separate bands, not
    // because they are literal bottom-up PDF points.
    try {
      switch (type) {
        case 'Highlight':
          a.setQuadPoints([[72, 710, 300, 710, 72, 735, 300, 735]]) // band 1 (top), yellow
          a.setColor([1, 0.9, 0.2])
          break
        case 'Underline':
          a.setQuadPoints([[72, 660, 300, 660, 72, 685, 300, 685]]) // band 2, red
          a.setColor([0.8, 0, 0])
          break
        case 'StrikeOut':
          a.setQuadPoints([[72, 610, 300, 610, 72, 635, 300, 635]]) // band 3, purple
          a.setColor([0.5, 0, 0.8])
          break
        case 'Ink':
          a.setInkList([
            [
              [100, 560],
              [140, 590],
              [180, 560],
              [220, 590],
            ],
          ]) // band 4
          a.setColor([0, 0, 0])
          a.setBorderWidth(2)
          break
        case 'FreeText':
          a.setRect([72, 480, 400, 530]) // band 5
          a.setContents('FreeText styling probe — does alignment work?')
          a.setDefaultAppearance('Helv', 14, [0.1, 0.2, 0.8])
          a.setQuadding(1) // 0=left,1=center,2=right
          break
        case 'Square':
          a.setRect([72, 400, 200, 460]) // band 6, left
          a.setColor([0.8, 0, 0])
          a.setInteriorColor([1, 0.8, 0.8])
          a.setBorderWidth(2)
          break
        case 'Circle':
          a.setRect([220, 400, 350, 460]) // band 6, right of Square
          a.setColor([0, 0.6, 0])
          a.setBorderWidth(2)
          break
        case 'Line':
          a.setLine([72, 340], [300, 340]) // band 7
          a.setColor([0, 0, 1])
          a.setBorderWidth(3)
          break
        case 'Link':
          a.setRect([72, 280, 300, 300]) // band 8 — expected to FAIL, see below
          break
        case 'Stamp':
          a.setRect([400, 400, 550, 450]) // right column, level with band 6
          break
      }
      const changed = a.update()
      console.log(`  update() returned: ${changed}`)
      console.log(`  /AP present: ${apPresent(a)}`)
    } catch (e) {
      console.log(`  prop-set/update FAILED: ${(e as Error).message}`)
    }
  } catch (e) {
    console.log(`\n${type}: createAnnotation FAILED — ${(e as Error).message}`)
  }
}

// Link annotation: does PDFAnnotation expose setURI directly, per the brief's assumption?
console.log('\n--- Link annotation setURI probe ---')
try {
  const link = page.createAnnotation('Link')
  link.setRect([72, 260, 300, 280])
  const hasSetURI = typeof (link as unknown as { setURI?: unknown }).setURI
  console.log('PDFAnnotation(Link).setURI typeof:', hasSetURI)
  console.log(
    'PDFAnnotation(Link) own-prototype methods:',
    Object.getOwnPropertyNames(Object.getPrototypeOf(link)).sort().join(', '),
  )
  link.update()
} catch (e) {
  console.log('Link probe FAILED:', (e as Error).message)
}

// The separate, non-annotation Link class (page.createLink) — brief did not mention this,
// but the .d.ts shows a distinct `Link` (fz_link) class with setURI. Probe it too.
console.log('\n--- page.createLink() (distinct fz_link API, not an annotation) ---')
try {
  const fzLink = page.createLink([72, 220, 300, 240], 'https://example.com')
  console.log('createLink OK, getURI():', fzLink.getURI())
  console.log('fz_link own-prototype methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(fzLink)).sort().join(', '))
} catch (e) {
  console.log('createLink FAILED:', (e as Error).message)
}

writeFileSync('spikes/out-annots.pdf', doc.saveToBuffer('compress').asUint8Array())
console.log('\nWrote spikes/out-annots.pdf')

// --- Render back to PNG with mupdf itself, for visual inspection ---
const outDoc = mupdf.Document.openDocument(
  readFileSync('spikes/out-annots.pdf'),
  'application/pdf',
) as mupdf.PDFDocument
let outPage: mupdf.PDFPage | undefined
let pix: mupdf.Pixmap | undefined
try {
  outPage = outDoc.loadPage(0)
  pix = outPage.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true)
  writeFileSync('spikes/out-annots-mupdf-render.png', pix.asPNG())
  console.log('Wrote spikes/out-annots-mupdf-render.png (mupdf self-render)')
} finally {
  pix?.destroy()
  outPage?.destroy()
}
