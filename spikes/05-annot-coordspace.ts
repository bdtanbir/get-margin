// Restores evidence for the Q2 coordinate-space finding in docs/findings/02-write-path.md.
// Two checks, both previously only narrated (deleted ad-hoc probes, not committed — this is
// the fix): (A) setRect()/getRect() vs the raw on-disk /Rect dict value, across a save+reload
// round trip; (B) pixel-sampling the rendered PNG to independently confirm which coordinate
// convention (flipped vs unflipped) actually matches what gets drawn.
import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync } from 'node:fs'
import { PNG } from '../packages/pdf-core/node_modules/pngjs/lib/png.js'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

console.log('=== Part A: setRect()/getRect() vs raw /Rect dict, save+reload round trip ===')
const doc = mupdf.Document.openDocument(
  new Uint8Array(readFileSync(fixturePath('simple-text'))),
  'application/pdf',
) as mupdf.PDFDocument
const page = doc.loadPage(0) as mupdf.PDFPage
const sq = page.createAnnotation('Square')
sq.setRect([72, 400, 200, 460])
console.log('getRect() immediately after setRect([72,400,200,460]):', sq.getRect())
sq.setColor([0.8, 0, 0])
sq.update()
console.log('raw dict /Rect via getObject().get("Rect").asJS():', sq.getObject().get('Rect').asJS())

const savedBytes = doc.saveToBuffer('compress').asUint8Array()
writeFileSync('spikes/out-coordspace-test.pdf', savedBytes)
const reDoc = mupdf.Document.openDocument(savedBytes, 'application/pdf') as mupdf.PDFDocument
const rePage = reDoc.loadPage(0) as mupdf.PDFPage
const annots = rePage.getAnnotations()
console.log('reloaded annotation count:', annots.length)
for (const a of annots) {
  console.log('  type:', a.getType(), 'getRect():', a.getRect(), 'raw /Rect:', a.getObject().get('Rect').asJS())
}

console.log('\n=== Part B: pixel-sample the committed render to confirm the convention ===')
// Reuses spikes/out-annots-mupdf-render.png (committed in dc56316), which was rendered at
// scale=2 from a 612x792 page with these known annotation placements (see 03-annotations.ts):
//   Highlight quad y = [710,735], Square rect y = [400,460], Line endpoints y = 340.
const png = PNG.sync.read(readFileSync('spikes/out-annots-mupdf-render.png'))
console.log('image size:', png.width, png.height)

function sample(xPt: number, yPtMid: number, label: string) {
  for (const [name, topdownY] of [
    ['flipped(standard, img=(792-y)*2)', Math.round((792 - yPtMid) * 2)],
    ['unflipped(img=y*2)', Math.round(yPtMid * 2)],
  ] as const) {
    const px = Math.round(xPt * 2)
    const py = topdownY
    if (py < 0 || py >= png.height) {
      console.log(`${label} [${name}] (${px},${py}): out of bounds`)
      continue
    }
    const idx = (png.width * py + px) << 2
    const r = png.data[idx]
    const g = png.data[idx + 1]
    const b = png.data[idx + 2]
    console.log(`${label} [${name}] px=(${px},${py}) rgb=(${r},${g},${b})`)
  }
}

sample(150, 722, 'Highlight band (x=150, raw y mid~722, yellow expected)')
sample(130, 430, 'Square band (x=130, raw y mid~430, pink/red expected)')
sample(150, 340, 'Line band (x=150, raw y~340, blue expected)')

// Also do a whole-image scan for the exact row range of three unambiguous colors, to get
// ground truth without needing to guess an exact sample point.
function findRows(matchFn: (r: number, g: number, b: number) => boolean, label: string) {
  let minY = Infinity
  let maxY = -Infinity
  let count = 0
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const idx = (png.width * y + x) << 2
      const r = png.data[idx]
      const g = png.data[idx + 1]
      const b = png.data[idx + 2]
      if (matchFn(r, g, b)) {
        count++
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  console.log(`${label}: count=${count} rows=[${minY},${maxY}]`)
}

findRows((r, g, b) => r < 20 && g < 20 && b > 230, 'Blue (Line, raw y=340)')
findRows((r, g, b) => r > 230 && g > 200 && g < 245 && b < 90, 'Yellow (Highlight, raw y=710-735)')
findRows((r, g, b) => r > 250 && g > 195 && g < 215 && b > 195 && b < 215, 'Pink fill (Square, raw y=400-460)')

console.log('\nExpected under "unflipped" hypothesis (img_row = raw_y * 2):')
console.log('  Line (y=340)      -> row ~680')
console.log('  Highlight (y=710-735) -> rows ~1420-1470')
console.log('  Square (y=400-460)    -> rows ~800-920')
console.log('Expected under "flipped standard" hypothesis (img_row = (792-raw_y)*2):')
console.log('  Line (y=340)      -> row ~904')
console.log('  Highlight (y=710-735) -> rows ~114-164')
console.log('  Square (y=400-460)    -> rows ~664-784')
