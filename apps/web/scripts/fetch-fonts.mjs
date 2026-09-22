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
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fonts')

const UA =
  'Mozilla/5.0 (Linux; U; Android 4.0.3; en-us) AppleWebKit/534.30 ' +
  '(KHTML, like Gecko) Version/4.0 Safari/534.30'

/**
 * The catalogue is `src/lib/fontCatalog.json`, shared with the app so the
 * picker offers exactly the weights that were fetched. `query` is the
 * Google Fonts `family=` value; `base` is the file stem.
 *
 * Every weight of every face is fetched upright and, where the family has
 * one, italic, and every one is a separate static instance rather than a
 * synthesised one: faux bold (stroking the regular) and faux italic
 * (shearing it) both keep the regular's advance widths, so the export's
 * alignment maths and the browser's preview would agree with each other and
 * disagree with the ink. An italic is its own file at every weight rather
 * than the upright on a slant, because in a serif face the italic is a
 * different alphabet, not the roman leaning over.
 *
 * `weights` and `italic` are what the endpoint actually publishes for the
 * family. Asking it for a weight a family does not have returns an EMPTY
 * stylesheet, not an error and not the nearest weight, so the list is
 * spelled out in the catalogue rather than assumed.
 *
 * Signature script faces are browser-only -- never embedded in a PDF,
 * because a typed signature is rasterised to a PNG. See LICENSES.md.
 */
const catalog = JSON.parse(
  await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'fontCatalog.json'), 'utf8'),
)

const FONTS = [...catalog.families, ...catalog.signature].flatMap(({ query, base, weights, italic }) =>
  weights.flatMap((w) => [
    { query, spec: `${w}`, file: `${base}-${w}.ttf` },
    ...(italic ? [{ query, spec: `${w}italic`, file: `${base}-${w}Italic.ttf` }] : []),
  ]),
)

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
  console.log(`${file.padEnd(28)} ${bytes.byteLength} bytes`)
}
