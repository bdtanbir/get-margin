/**
 * The curated font set, shared by preview and export.
 *
 * Spec 2.5: the browser measures and renders with the SAME BYTES the worker
 * embeds into the exported PDF, self-hosted so opening a document makes no
 * third-party request. `file` is explicit rather than derived from `family`
 * -- "Source Serif 4" does not munge into "SourceSerif4" by any rule worth
 * maintaining, and a wrong guess is a 404 at export time.
 *
 * See public/fonts/LICENSES.md for provenance and licences.
 */
export const FONTS = [
  { family: 'Inter', file: 'Inter.ttf', fallback: 'sans-serif' },
  { family: 'Roboto', file: 'Roboto.ttf', fallback: 'sans-serif' },
  { family: 'Source Serif 4', file: 'SourceSerif4.ttf', fallback: 'serif' },
  { family: 'Merriweather', file: 'Merriweather.ttf', fallback: 'serif' },
  { family: 'JetBrains Mono', file: 'JetBrainsMono.ttf', fallback: 'monospace' },
] as const

/**
 * Script faces for the TYPED SIGNATURE only (Task 35 Step 4).
 *
 * Deliberately NOT in FONTS above. These are browser-only: a typed
 * signature is rasterised to a transparent PNG and placed as an image, so
 * the face never needs embedding and never costs a document its ~66KB font
 * program. Keeping them out of FONTS also keeps them out of the text tool's
 * font picker, where a signature script is not what anyone wants for body
 * copy.
 *
 * Self-hosted for the same reason as FONTS (spec 2.5): no third-party
 * request when a document is opened.
 */
export const SIGNATURE_FACES = [
  { family: 'Caveat', file: 'Caveat.ttf', fallback: 'cursive' },
  { family: 'Dancing Script', file: 'DancingScript.ttf', fallback: 'cursive' },
  { family: 'Great Vibes', file: 'GreatVibes.ttf', fallback: 'cursive' },
] as const

/** Every face this app can load, whether or not it is embeddable. */
const ALL_FACES = [...FONTS, ...SIGNATURE_FACES]

export type FontFamily = (typeof FONTS)[number]['family']

export const DEFAULT_FAMILY: FontFamily = 'Inter'

/**
 * These must stay equal to ASCENT_RATIO / LINE_HEIGHT in
 * pdf-core/src/write/objects/text.ts. The overlay lays text out with these
 * numbers and the writer lays it out with those; a mismatch is text that
 * jumps the moment the document is exported.
 */
export const ASCENT_RATIO = 0.8
export const LINE_HEIGHT = 1.2

const entry = (family: string) => ALL_FACES.find((f) => f.family === family)

export function fontUrl(family: string): string {
  const f = entry(family)
  if (!f) throw new Error(`unknown font family "${family}"`)
  return `/fonts/${f.file}`
}

/** CSS font-family value: the real family, then its generic fallback. */
export function cssFamily(family: string): string {
  const f = entry(family)
  return f ? `"${f.family}", ${f.fallback}` : family
}

const loading = new Map<string, Promise<void>>()

/**
 * Register `family` with the document so it can be rendered and measured.
 * Cached by family: FontFace construction plus load() is a network fetch and
 * a parse, and the text tool asks for the active family on every keystroke.
 */
export function loadFont(family: string): Promise<void> {
  const hit = loading.get(family)
  if (hit) return hit
  const promise = (async () => {
    if (typeof FontFace === 'undefined' || !document.fonts) return
    const face = new FontFace(family, `url(${fontUrl(family)})`)
    await face.load()
    document.fonts.add(face)
  })()
  loading.set(family, promise)
  return promise
}

export function preloadFonts(): Promise<void[]> {
  return Promise.all(FONTS.map((f) => loadFont(f.family)))
}

/** The script faces, loaded on demand when the signature modal opens. */
export function loadSignatureFaces(): Promise<void[]> {
  return Promise.all(SIGNATURE_FACES.map((f) => loadFont(f.family)))
}

let ctx: CanvasRenderingContext2D | null | undefined

/**
 * Advance width of `text` in POINTS, for the overlay's alignment maths.
 *
 * Canvas measurement here vs. MuPDF glyph advances at export: both read the
 * same font file, so they agree to well under a point at normal sizes. They
 * are not bit-identical, and the export path is the authority -- this exists
 * so the preview does not visibly disagree, not as a second source of truth.
 *
 * Returns 0 rather than throwing when no canvas is available (jsdom, SSR):
 * a missing measurement degrades alignment, and throwing would take the
 * whole overlay down with it.
 */
export function measureText(text: string, family: string, size: number): number {
  if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return 0
  ctx.font = `${size}px ${cssFamily(family)}`
  return ctx.measureText(text).width
}

/** The raw file, for the worker to embed. Same bytes the browser rendered. */
export async function fontBytes(family: string): Promise<Uint8Array> {
  const res = await fetch(fontUrl(family))
  if (!res.ok) throw new Error(`could not load the font "${family}" (${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * Font bytes for every family the edit document actually uses. Loading all
 * five on every export would add ~340KB of fetches for a document that uses
 * one of them.
 */
export async function fontsForExport(
  families: Iterable<string>,
): Promise<Map<string, Uint8Array>> {
  // Only embeddable faces. A signature script reaching here would mean a
  // TEXT object had been given one, which the picker cannot produce -- and
  // embedding it would silently add ~60KB to a document for a face the
  // writer was never meant to see.
  const embeddable = new Set(FONTS.map((f) => f.family))
  const unique = [...new Set(families)].filter((f) => embeddable.has(f as FontFamily))
  const loaded = await Promise.all(unique.map(async (f) => [f, await fontBytes(f)] as const))
  return new Map(loaded)
}
