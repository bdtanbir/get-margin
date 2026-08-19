/**
 * Refetch the bundled fonts in `public/fonts/`.
 *
 * These files are committed, so this script is not part of the build — it
 * exists so the binaries in the repo have a reproducible provenance rather
 * than being unexplained blobs.
 *
 * WHY THE LEGACY USER AGENT: the Google Fonts CSS API picks a format from the
 * User-Agent. Modern agents get woff2, which MuPDF cannot read; this
 * Android 4 string is the one that still returns a plain static TrueType at
 * weight 400. The alternative source, google/fonts on GitHub, now publishes
 * only VARIABLE TTFs for these families, and since addSimpleFont embeds the
 * whole font program with no subsetting, variable Merriweather alone would
 * add 4.6 MB to every document that used it. See LICENSES.md.
 *
 * Usage: node scripts/fetch-fonts.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fonts')

const UA =
  'Mozilla/5.0 (Linux; U; Android 4.0.3; en-us) AppleWebKit/534.30 ' +
  '(KHTML, like Gecko) Version/4.0 Safari/534.30'

/** `query` is the Google Fonts `family=` value; `file` is what we write. */
const FONTS = [
  { query: 'Inter', file: 'Inter.ttf' },
  { query: 'Roboto', file: 'Roboto.ttf' },
  { query: 'Source+Serif+4', file: 'SourceSerif4.ttf' },
  { query: 'Merriweather', file: 'Merriweather.ttf' },
  { query: 'JetBrains+Mono', file: 'JetBrainsMono.ttf' },
  // Signature script faces. Browser-only -- never embedded in a PDF, because
  // a typed signature is rasterised to a PNG. See LICENSES.md.
  { query: 'Caveat', file: 'Caveat.ttf' },
  { query: 'Dancing+Script', file: 'DancingScript.ttf' },
  { query: 'Great+Vibes', file: 'GreatVibes.ttf' },
]

async function ttfUrl(query) {
  const css = await (
    await fetch(`https://fonts.googleapis.com/css?family=${query}:wght@400`, {
      headers: { 'User-Agent': UA },
    })
  ).text()
  const match = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/.exec(css)
  if (!match) throw new Error(`no font url in the CSS for "${query}"`)
  return match[1]
}

await mkdir(OUT, { recursive: true })
for (const { query, file } of FONTS) {
  const bytes = new Uint8Array(await (await fetch(await ttfUrl(query))).arrayBuffer())
  // TrueType files start with 0x00010000; a woff2 starts 'wOF2'. Fail loudly
  // rather than committing something MuPDF will reject at export time.
  const magic = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0)
  if (magic !== 0x00010000) {
    throw new Error(`${file}: expected TrueType, got magic 0x${magic.toString(16)}`)
  }
  await writeFile(join(OUT, file), bytes)
  console.log(`${file.padEnd(20)} ${bytes.byteLength} bytes`)
}
