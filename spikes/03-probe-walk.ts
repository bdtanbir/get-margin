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
const seenFonts = new Map<string, { mono: boolean; serif: boolean; bold: boolean; italic: boolean }>()
st.walk({
  onChar(c, origin, font, size, quad, color, bidi) {
    charCount++
    const name = font.getName?.()
    // Runtime-verify the Font method list, not just read it off the .d.ts: call each
    // predicate and record the real result once per distinct font name seen.
    if (name && !seenFonts.has(name)) {
      seenFonts.set(name, {
        mono: font.isMono(),
        serif: font.isSerif(),
        bold: font.isBold(),
        italic: font.isItalic(),
      })
    }
    if (sample.length < 6) {
      sample.push({ c, origin, fontName: name, size, quad, color, bidi })
    }
  },
})
console.log('total chars walked:', charCount)
console.log('sample onChar records:', JSON.stringify(sample, null, 2))
console.log('\nper-distinct-font Font predicate results (runtime-verified, not read off .d.ts):')
for (const [name, flags] of seenFonts) {
  console.log(` ${name}:`, JSON.stringify(flags))
}
