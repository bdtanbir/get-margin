/**
 * Refetch the bundled fonts in `public/fonts/`.
 *
 * These files are committed, so this script is not part of the build — it
 * exists so the binaries in the repo have a reproducible provenance rather
 * than being unexplained blobs.
 *
 * WHY THE LEGACY USER AGENT: the Google Fonts CSS API picks a format from the
 * User-Agent. Modern agents get woff2, which MuPDF cannot read; this
 * Android 4 string is the one that still returns a plain static TrueType.
 * The alternative source, google/fonts on GitHub, now publishes only
 * VARIABLE TTFs for these families, and since addSimpleFont embeds the
 * whole font program with no subsetting, variable Merriweather alone would
 * add 4.6 MB to every document that used it. See LICENSES.md.
 *
 * WHY `:700` AND NOT `:wght@700`: this is the **v1** CSS endpoint, and it
 * takes styles as a bare list -- `400`, `700`, `400italic`, `700italic`.
 * `wght@700` is css2 syntax; the v1 endpoint does not recognise it,
 * silently ignores it, and serves weight 400. That is not a hypothetical --
 * the bold faces were first fetched that way and every one of them came
 * back as the regular, byte-for-byte identical advance widths and all. The
 * magic check below cannot catch it, because a regular TrueType is still a
 * valid TrueType, so the assertions that DO catch it live in
 * test/lib/fonts.test.ts, reading each file's own OS/2 weight class and its
 * fsSelection BOLD and ITALIC bits.
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

/**
 * `query` is the Google Fonts `family=` value; `file` is what we write.
 *
 * Each body face is fetched in all FOUR styles. Every one is a separate
 * static instance rather than a synthesised one: faux bold (stroking the
 * regular) and faux italic (shearing it) both keep the regular's advance
 * widths, so the export's alignment maths and the browser's preview would
 * agree with each other and disagree with the ink. Bold italic is its own
 * file rather than the bold one on a slant, because in a serif face the
 * italic is a different alphabet, not the roman leaning over.
 */
const FONTS = [
  ...[
    { query: 'Inter', base: 'Inter' },
    { query: 'Roboto', base: 'Roboto' },
    { query: 'Source+Serif+4', base: 'SourceSerif4' },
    { query: 'Merriweather', base: 'Merriweather' },
    { query: 'JetBrains+Mono', base: 'JetBrainsMono' },
  ].flatMap(({ query, base }) => [
    { query, spec: '400', file: `${base}.ttf` },
    { query, spec: '700', file: `${base}-Bold.ttf` },
    { query, spec: '400italic', file: `${base}-Italic.ttf` },
    { query, spec: '700italic', file: `${base}-BoldItalic.ttf` },
  ]),
  // Signature script faces. Browser-only -- never embedded in a PDF, because
  // a typed signature is rasterised to a PNG. See LICENSES.md. One style
  // only: a signature is written in one hand, and a script face is already
  // slanted.
  { query: 'Caveat', spec: '400', file: 'Caveat.ttf' },
  { query: 'Dancing+Script', spec: '400', file: 'DancingScript.ttf' },
  { query: 'Great+Vibes', spec: '400', file: 'GreatVibes.ttf' },
]

async function ttfUrl(query, spec) {
  const css = await (
    await fetch(`https://fonts.googleapis.com/css?family=${query}:${spec}`, {
      headers: { 'User-Agent': UA },
    })
  ).text()
  const match = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/.exec(css)
  if (!match) throw new Error(`no font url in the CSS for "${query}" at ${spec}`)
  return match[1]
}

await mkdir(OUT, { recursive: true })
for (const { query, spec, file } of FONTS) {
  const bytes = new Uint8Array(await (await fetch(await ttfUrl(query, spec))).arrayBuffer())
  // TrueType files start with 0x00010000; a woff2 starts 'wOF2'. Fail loudly
  // rather than committing something MuPDF will reject at export time.
  const magic = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0)
  if (magic !== 0x00010000) {
    throw new Error(`${file}: expected TrueType, got magic 0x${magic.toString(16)}`)
  }
  await writeFile(join(OUT, file), bytes)
  console.log(`${file.padEnd(20)} ${bytes.byteLength} bytes`)
}
