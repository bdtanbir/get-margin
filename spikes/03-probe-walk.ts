import * as mupdf from 'mupdf'
import { readFileSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

// asJSON() has no options param besides scale (see mupdf.d.ts: asJSON(scale?: number)).
// The options string is only accepted by toStructuredText(). Per-char data is only
// reachable via walk({onChar}), which gives quad (bbox) + font + size per character.
const doc = mupdf.Document.openDocument(new Uint8Array(readFileSync(fixturePath('mixed-fonts'))), 'application/pdf')
const page = doc.loadPage(0)
const st = page.toStructuredText('preserve-whitespace')

let charCount = 0
const sample: unknown[] = []
st.walk({
  onChar(c, origin, font, size, quad, color, bidi) {
    charCount++
    if (sample.length < 6) {
      sample.push({ c, origin, fontName: font.getName?.(), size, quad, color, bidi })
    }
  },
})
console.log('total chars walked:', charCount)
console.log('sample onChar records:', JSON.stringify(sample, null, 2))
