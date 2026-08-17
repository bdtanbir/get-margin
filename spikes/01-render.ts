import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

function mb(): number { return Math.round(process.memoryUsage().rss / 1048576) }

/** Print the real API surface rather than trusting docs — this is the point of the spike. */
function surface(label: string, obj: object): void {
  const proto = Object.getPrototypeOf(obj)
  console.log(`\n--- ${label} methods ---`)
  console.log(Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor').sort().join(', '))
}

const DISPOSE = process.env.SPIKE_DISPOSE !== '0'
console.log('DISPOSE =', DISPOSE, '(set SPIKE_DISPOSE=0 to skip destroy() calls)')

const buf = readFileSync(fixturePath('simple-text'))
const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
surface('Document', doc)
console.log('pages:', doc.countPages())

const page = doc.loadPage(0)
surface('Page', page)
console.log('getBounds():', page.getBounds())

// Q1: minimal path to pixels.
const scale = 2
const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
surface('Pixmap', pix)
console.log('pixmap:', pix.getWidth(), 'x', pix.getHeight(), 'stride?', (pix as never as { getStride?: () => number }).getStride?.())
const pixels = pix.getPixels()
console.log('pixels bytes:', pixels.length, 'bytes/px:', pixels.length / (pix.getWidth() * pix.getHeight()))
writeFileSync('spikes/out-simple.png', pix.asPNG())

// Q5: CropBox vs MediaBox.
const cropDoc = mupdf.Document.openDocument(new Uint8Array(readFileSync(fixturePath('offset-cropbox'))), 'application/pdf')
const cropPage = cropDoc.loadPage(0)
console.log('\noffset-cropbox getBounds():', cropPage.getBounds(), '(expected CropBox [50,80,400,500])')

// Q6: rotation handling.
const rotDoc = mupdf.Document.openDocument(new Uint8Array(readFileSync(fixturePath('rotated'))), 'application/pdf')
for (let i = 0; i < 4; i++) {
  const p = rotDoc.loadPage(i)
  const b = p.getBounds()
  const px = p.toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false, true)
  console.log(`page ${i}: bounds=${JSON.stringify(b)} pixmap=${px.getWidth()}x${px.getHeight()}`)
  writeFileSync(`spikes/out-rot-${i}.png`, px.asPNG())
}
console.log('If pixmap dims SWAP on pages 1 and 3, toPixmap applies /Rotate itself.')

// Q2/Q3: throughput and memory.
const bigDoc = mupdf.Document.openDocument(new Uint8Array(readFileSync(fixturePath('large-300p'))), 'application/pdf')
let peakRss = mb()
for (const s of [1, 2]) {
  const t0 = performance.now()
  let firstMs = 0
  const rssStart = mb()
  for (let i = 0; i < 300; i++) {
    const pg = bigDoc.loadPage(i)
    const pm = pg.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true)
    pm.getPixels()
    if (i === 0) firstMs = performance.now() - t0
    // Q3: does explicit destroy exist, and does omitting it leak?
    if (DISPOSE) {
      ;(pm as never as { destroy?: () => void }).destroy?.()
      ;(pg as never as { destroy?: () => void }).destroy?.()
    }
    const cur = mb()
    if (cur > peakRss) peakRss = cur
    if (i % 100 === 0) console.log(`  scale ${s} page ${i} rss=${cur}MB`)
  }
  const total = performance.now() - t0
  console.log(`scale ${s}: first=${firstMs.toFixed(0)}ms total=${(total / 1000).toFixed(1)}s rate=${(300 / (total / 1000)).toFixed(1)}pg/s rssDelta=${mb() - rssStart}MB`)
}
console.log('peakRss during 300-page loops:', peakRss, 'MB')
