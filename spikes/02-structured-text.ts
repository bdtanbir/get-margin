import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

for (const fixture of ['simple-text', 'mixed-fonts'] as const) {
  const doc = mupdf.Document.openDocument(new Uint8Array(readFileSync(fixturePath(fixture))), 'application/pdf')
  const page = doc.loadPage(0)

  // Try each option string — availability varies by version, and preserve-spans is
  // what makes stable run addressing possible (spec §2.4 step 2).
  for (const opts of ['', 'preserve-whitespace', 'preserve-whitespace,preserve-spans']) {
    try {
      const st = page.toStructuredText(opts)
      const json = JSON.parse(st.asJSON())
      console.log(`\n=== ${fixture} opts="${opts}" ===`)
      console.log('top-level keys:', Object.keys(json))
      const block = json.blocks?.[0]
      console.log('block keys:', block && Object.keys(block))
      const line = block?.lines?.[0]
      console.log('line keys:', line && Object.keys(line))
      const span = line?.spans?.[0] ?? line
      console.log('span keys:', span && Object.keys(span))
      console.log('span sample:', JSON.stringify(span)?.slice(0, 600))
      writeFileSync(`spikes/out-st-${fixture}-${opts.length}.json`, JSON.stringify(json, null, 2))
    } catch (e) {
      console.log(`opts="${opts}" FAILED:`, (e as Error).message)
    }
  }
}
console.log('\nCheck the written JSON for: per-span font name/size/weight/italic, per-char bbox, and whether spans exist at all.')
