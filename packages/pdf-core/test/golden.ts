import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PdfDocument, renderPage } from '../src/index.js'

const GOLDEN_DIR = join(new URL('.', import.meta.url).pathname, 'golden')

/**
 * Read live rather than captured once at module load, so tests can flip
 * process.env.UPDATE_GOLDENS around a single call without needing a fresh
 * module instance.
 */
function updateRequested(): boolean {
  return process.env.UPDATE_GOLDENS === '1'
}

/**
 * Golden names become filenames under GOLDEN_DIR with no further sanitising.
 * Reject anything that could escape that directory — this helper is meant to
 * be called from many future export tests, and a path-separator or `..` in a
 * name (e.g. an interpolated variable) must fail loudly, not silently write
 * outside test/golden/.
 */
function assertSafeName(name: string): void {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(
      `[golden] invalid golden name "${name}": must not contain "/", "\\", or "..".`,
    )
  }
}

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
  assertSafeName(name)
  const { page = 0, scale = 1, maxDiffRatio = 0, threshold = 0.1 } = opts
  const UPDATE = updateRequested()
  await mkdir(GOLDEN_DIR, { recursive: true })

  const goldenPath = join(GOLDEN_DIR, `${name}.png`)
  const actualPng = await renderToPng(pdf, page, scale)

  if (UPDATE || !existsSync(goldenPath)) {
    // Re-baselining overwrites the definition of "correct" with zero
    // comparison. That is what UPDATE_GOLDENS=1 means — but doing it with
    // zero *output* would let a regressed render silently become the new
    // golden, leaving no trace in a CI log or a diff. Make the overwrite
    // loud whenever there was a previous golden to compare against.
    if (UPDATE && existsSync(goldenPath)) {
      const previous = PNG.sync.read(await readFile(goldenPath))
      const incoming = PNG.sync.read(actualPng)
      if (previous.width !== incoming.width || previous.height !== incoming.height) {
        console.warn(
          `[golden] REBASELINED ${name}.png: size changed ` +
          `${previous.width}x${previous.height} -> ${incoming.width}x${incoming.height}.`,
        )
      } else {
        const diff = new PNG({ width: previous.width, height: previous.height })
        const diffPixels = pixelmatch(
          previous.data, incoming.data, diff.data, previous.width, previous.height,
          { threshold, includeAA: false },
        )
        const total = previous.width * previous.height
        if (diffPixels > 0) {
          console.warn(
            `[golden] REBASELINED ${name}.png: ${diffPixels}/${total} pixels ` +
            `(${(diffPixels / total * 100).toFixed(3)}%) differ from the previous golden.`,
          )
        }
      }
    }

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
