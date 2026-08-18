// Restores evidence for Q4 in docs/findings/02-write-path.md: an arbitrary embedded TTF can be
// drawn via the low-level Text/Device primitives (not just registered), and the resulting
// advance matches an independently-computed sum of per-glyph advances.
import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync } from 'node:fs'

const fontBytes = new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Zapfino.ttf'))
const font = new mupdf.Font('Zapfino', fontBytes)

const text = new mupdf.Text()
const str = 'Custom TTF via showString'
const size = 28
const trm: mupdf.Matrix = [size, 0, 0, size, 20, 60]
const endMatrix = text.showString(font, trm, str)
console.log('showString returned end matrix (cursor after drawing):', endMatrix)
console.log('advance in x (endMatrix[4] - trm[4]):', endMatrix[4] - trm[4], 'pt for', str.length, 'chars at size', size)

let manualAdvance = 0
for (const ch of str) {
  const gid = font.encodeCharacter(ch)
  const adv = font.advanceGlyph(gid)
  manualAdvance += adv * size
}
console.log('manual sum of advanceGlyph(encodeCharacter(ch)) * size:', manualAdvance)

const bbox: mupdf.Rect = [0, 0, 700, 120]
const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false)
pix.clear(255)
const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0, 0, 0], 1)
dev.close()
writeFileSync('spikes/out-drawtext-probe.png', pix.asPNG())
console.log('wrote spikes/out-drawtext-probe.png')
pix.destroy()
