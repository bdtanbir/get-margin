import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PdfDocument, renderPage } from '../src/index.js'

const GOLDEN_DIR = join(new URL('.', import.meta.url).pathname, 'golden')
const UPDATE = process.env.UPDATE_GOLDENS === '1'

export type GoldenOptions = {
  page?: number
  scale?: number
  /** Fraction of differing pixels tolerated. Default 0 — exact match. */
  maxDiffRatio?: number
  /** pixelmatch per-pixel colour sensitivity, 0..1. Default 0.1. */
  threshold?: number
}

export async function renderToPng(pdf: Uint8Array, page = 0, scale = 1): Promise<Buffer> {
  const doc = PdfDocument.open(pdf)
  try {
    const { width, height, rgba } = renderPage(doc, page, scale)
    const png = new PNG({ width, height })
    png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)
    return PNG.sync.write(png)
  } finally {
    doc.close()
  }
}

/**
 * Render `pdf` and compare against the reviewed golden image for `name`.
 *
 * Missing goldens are written and the assertion passes with a warning — the
 * new file must then be reviewed by eye and committed. Run the whole suite with
 * UPDATE_GOLDENS=1 to re-baseline after an intentional rendering change.
 */
export async function assertGolden(name: string, pdf: Uint8Array, opts: GoldenOptions = {}): Promise<void> {
  const { page = 0, scale = 1, maxDiffRatio = 0, threshold = 0.1 } = opts
  await mkdir(GOLDEN_DIR, { recursive: true })

  const goldenPath = join(GOLDEN_DIR, `${name}.png`)
  const actualPng = await renderToPng(pdf, page, scale)

  if (UPDATE || !existsSync(goldenPath)) {
    await writeFile(goldenPath, actualPng)
    if (!UPDATE) {
      console.warn(
        `[golden] created ${name}.png — REVIEW IT BY EYE and commit it. ` +
        `An unreviewed golden asserts nothing.`,
      )
    }
    return
  }

  const expected = PNG.sync.read(await readFile(goldenPath))
  const actual = PNG.sync.read(actualPng)

  if (expected.width !== actual.width || expected.height !== actual.height) {
    await writeFile(join(GOLDEN_DIR, `${name}.actual.png`), actualPng)
    throw new Error(
      `[golden] ${name} differs from golden: size ${actual.width}x${actual.height} ` +
      `vs expected ${expected.width}x${expected.height}. Wrote ${name}.actual.png`,
    )
  }

  const diff = new PNG({ width: expected.width, height: expected.height })
  const diffPixels = pixelmatch(
    expected.data, actual.data, diff.data, expected.width, expected.height,
    { threshold, includeAA: false },
  )
  const total = expected.width * expected.height
  const ratio = diffPixels / total

  if (ratio > maxDiffRatio) {
    await writeFile(join(GOLDEN_DIR, `${name}.actual.png`), actualPng)
    await writeFile(join(GOLDEN_DIR, `${name}.diff.png`), PNG.sync.write(diff))
    throw new Error(
      `[golden] ${name} differs from golden: ${diffPixels}/${total} pixels ` +
      `(${(ratio * 100).toFixed(3)}%) exceed maxDiffRatio ${maxDiffRatio}. ` +
      `Wrote ${name}.actual.png and ${name}.diff.png — open the diff before assuming it's noise.`,
    )
  }
}
