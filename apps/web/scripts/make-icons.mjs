/**
 * Generate the PWA icon set in `public/icons/` from the mark defined below.
 *
 * These files are committed, so this script is not part of the build — it
 * exists for the same reason `fetch-fonts.mjs` does: so the binaries in the
 * repo have a reproducible provenance rather than being blobs nobody can
 * regenerate. Edit `mark()`, re-run, commit what changes.
 *
 * WHY PLAYWRIGHT AND NOT AN IMAGE LIBRARY: the app already depends on
 * Playwright for e2e, and Chromium is the only rasteriser here that agrees
 * with the browsers these icons are rendered in. It is also the only one
 * that understands `oklch()`, which is the colour space the design tokens
 * are written in — hand-converting the accent colour to hex would put a
 * second, drifting copy of the brand colour in the repo.
 *
 * Usage: node scripts/make-icons.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ICONS = join(ROOT, 'public', 'icons')

/** The accent, copied from `src/app/styles/tokens.css` (light theme). */
const ACCENT = 'oklch(0.53 0.2 268)'
const ACCENT_DEEP = 'oklch(0.42 0.19 272)'

/**
 * The mark: a sheet with a ruled margin down its left edge.
 *
 * `inset` is the fraction of the canvas left empty around the sheet.
 * Android's maskable icons crop to an arbitrary shape and only the middle
 * 80% is guaranteed to survive, so the maskable variant is drawn with a
 * larger inset rather than being the same art scaled down — scaling would
 * shrink the sheet AND the corner radius, and the radius is what makes the
 * silhouette read as an app icon.
 */
function mark({ size, inset, radius }) {
  const s = (n) => (n * size).toFixed(2)
  // Sheet geometry, as fractions of the canvas.
  const x = inset
  const w = 1 - inset * 2
  const h = w * 1.26
  const y = (1 - h) / 2
  const rule = x + w * 0.22

  const line = (ty, tw) =>
    `<rect x="${s(rule + w * 0.1)}" y="${s(y + h * ty)}" width="${s(w * tw)}" ` +
    `height="${s(w * 0.055)}" rx="${s(w * 0.0275)}" fill="oklch(0.72 0.02 265)"/>`

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${ACCENT}"/>
      <stop offset="1" stop-color="${ACCENT_DEEP}"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${s(radius)}" fill="url(#bg)"/>
  <rect x="${s(x)}" y="${s(y)}" width="${s(w)}" height="${s(h)}"
        rx="${s(w * 0.08)}" fill="oklch(0.99 0 0)"/>
  <rect x="${s(rule)}" y="${s(y + h * 0.1)}" width="${s(w * 0.035)}" height="${s(h * 0.8)}"
        rx="${s(w * 0.0175)}" fill="${ACCENT}" opacity="0.5"/>
  ${line(0.24, 0.5)}
  ${line(0.4, 0.42)}
  ${line(0.56, 0.5)}
  ${line(0.72, 0.3)}
</svg>`.trim()
}

/** Standard icons keep a modest inset and round their own corners. */
const STANDARD = { inset: 0.22, radius: 0.22 }
/** Maskable art must survive a crop to the middle 80%: no self-rounding. */
const MASKABLE = { inset: 0.3, radius: 0 }
/** iOS applies its own squircle to an opaque square, so this one is flat. */
const APPLE = { inset: 0.22, radius: 0 }

const OUTPUTS = [
  { file: 'icon-192.png', size: 192, ...STANDARD },
  { file: 'icon-512.png', size: 512, ...STANDARD },
  { file: 'maskable-512.png', size: 512, ...MASKABLE },
  { file: 'apple-touch-icon-180.png', size: 180, ...APPLE },
]

async function main() {
  await mkdir(ICONS, { recursive: true })

  // The favicon ships as vector: it is drawn at 16px in a tab and at 32px
  // in a bookmark bar, and one SVG beats guessing which raster sizes a
  // browser will ask for.
  await writeFile(join(ROOT, 'public', 'favicon.svg'), mark({ size: 512, ...STANDARD }) + '\n')

  const browser = await chromium.launch()
  try {
    for (const { file, size, inset, radius } of OUTPUTS) {
      const page = await browser.newPage({ viewport: { width: size, height: size } })
      await page.setContent(
        `<style>html,body{margin:0;padding:0}</style>${mark({ size, inset, radius })}`,
      )
      const png = await page.screenshot({ omitBackground: false })
      await writeFile(join(ICONS, file), png)
      await page.close()
      console.log(`wrote public/icons/${file} (${size}x${size}, ${png.length} bytes)`)
    }
  } finally {
    await browser.close()
  }
  console.log('wrote public/favicon.svg')
}

await main()
