import * as mupdf from 'mupdf'
import { readFileSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

function fullChain(label: string, obj: object): void {
  console.log(`\n--- ${label} full prototype chain ---`)
  let proto = Object.getPrototypeOf(obj)
  let depth = 0
  while (proto && proto !== Object.prototype) {
    const names = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor')
    console.log(`  [depth ${depth}] ${proto.constructor?.name}:`, names.sort().join(', '))
    proto = Object.getPrototypeOf(proto)
    depth++
  }
}

const doc = mupdf.Document.openDocument(new Uint8Array(readFileSync(fixturePath('simple-text'))), 'application/pdf')
const page = doc.loadPage(0)
const pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true)

fullChain('Document', doc)
fullChain('Page', page)
fullChain('Pixmap', pix)

console.log('\nown props on pix instance:', Object.getOwnPropertyNames(pix))
console.log('destroy in pix?', 'destroy' in pix, typeof (pix as unknown as Record<string, unknown>).destroy)
console.log('drop in pix?', 'drop' in pix)
console.log('free in pix?', 'free' in pix)
console.log('dispose in pix?', 'dispose' in pix)
console.log('close in pix?', 'close' in pix)

// check mupdf module top-level for a manual GC / userdata clear
console.log('\nmupdf module keys:', Object.keys(mupdf))
