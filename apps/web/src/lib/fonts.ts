import type { EditObject } from '@margin/pdf-core'
import { faceKey } from '@margin/pdf-core'

export { faceKey }

/**
 * The curated font set, shared by preview and export.
 *
 * Spec 2.5: the browser measures and renders with the SAME BYTES the worker
 * embeds into the exported PDF, self-hosted so opening a document makes no
 * third-party request. `file` is explicit rather than derived from `family`
 * -- "Source Serif 4" does not munge into "SourceSerif4" by any rule worth
 * maintaining, and a wrong guess is a 404 at export time.
 *
 * `bold` is a SEPARATE FILE, not a flag. Asking the browser for weight 700
 * with only the regular registered gets faux bold -- stroked regular
 * outlines that keep the regular's advance widths -- while the export would
 * embed a real bold face with different ones. The two would disagree about
 * where a centred line starts. One file per weight keeps preview and export
 * measuring the same glyphs, which is the whole point of self-hosting them.
 *
 * See public/fonts/LICENSES.md for provenance and licences.
 */
export const FONTS = [
  { family: 'Inter', file: 'Inter.ttf', bold: 'Inter-Bold.ttf', fallback: 'sans-serif' },
  { family: 'Roboto', file: 'Roboto.ttf', bold: 'Roboto-Bold.ttf', fallback: 'sans-serif' },
  { family: 'Source Serif 4', file: 'SourceSerif4.ttf', bold: 'SourceSerif4-Bold.ttf', fallback: 'serif' },
  { family: 'Merriweather', file: 'Merriweather.ttf', bold: 'Merriweather-Bold.ttf', fallback: 'serif' },
  { family: 'JetBrains Mono', file: 'JetBrainsMono.ttf', bold: 'JetBrainsMono-Bold.ttf', fallback: 'monospace' },
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
 *
 * No bold: a signature is written in one hand, and a heavier one is not a
 * setting anybody reaches for. `bold: undefined` also keeps `faceFile`
 * below honest -- asking for a bold script face fails rather than quietly
 * handing back the regular.
 */
export const SIGNATURE_FACES = [
  { family: 'Caveat', file: 'Caveat.ttf', bold: undefined, fallback: 'cursive' },
  { family: 'Dancing Script', file: 'DancingScript.ttf', bold: undefined, fallback: 'cursive' },
  { family: 'Great Vibes', file: 'GreatVibes.ttf', bold: undefined, fallback: 'cursive' },
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

/**
 * The CSS `font-weight` a face is registered and asked for under.
 *
 * Named rather than spelled `700` at each site, because the number has to
 * be identical in three places -- the FontFace descriptor, the canvas
 * measurement string, and the SVG/DOM that renders -- or the browser
 * synthesises a bold instead of using the file we shipped, and nothing
 * says so.
 */
export const BOLD_WEIGHT = '700'
export const REGULAR_WEIGHT = '400'

export const cssWeight = (bold?: boolean): string =>
  bold ? BOLD_WEIGHT : REGULAR_WEIGHT

/**
 * The file behind a family at a weight.
 *
 * Throws for a bold script face rather than falling back to its regular: a
 * silent fallback here would render one thing and embed another.
 */
export function faceFile(family: string, bold?: boolean): string {
  const f = entry(family)
  if (!f) throw new Error(`unknown font family "${family}"`)
  if (!bold) return f.file
  if (!f.bold) throw new Error(`"${family}" has no bold face`)
  return f.bold
}

export function fontUrl(family: string, bold?: boolean): string {
  return `/fonts/${faceFile(family, bold)}`
}

/** CSS font-family value: the real family, then its generic fallback. */
export function cssFamily(family: string): string {
  const f = entry(family)
  return f ? `"${f.family}", ${f.fallback}` : family
}

const loading = new Map<string, Promise<void>>()

/**
 * Register a face with the document so it can be rendered and measured.
 *
 * Both weights register under the SAME CSS family name, distinguished by
 * the FontFace `weight` descriptor. That is what makes `font-weight: 700`
 * in the overlay pick up Inter-Bold.ttf instead of asking the browser to
 * fake it by stroking the regular -- and a faked bold would measure at the
 * regular's advance widths while the export used the real ones.
 *
 * Cached by FACE, not family: the text tool asks for the active face on
 * every keystroke, and FontFace construction plus load() is a fetch and a
 * parse.
 */
export function loadFont(family: string, bold?: boolean): Promise<void> {
  const key = faceKey(family, bold)
  const hit = loading.get(key)
  if (hit) return hit
  const promise = (async () => {
    if (typeof FontFace === 'undefined' || !document.fonts) return
    const face = new FontFace(family, `url(${fontUrl(family, bold)})`, {
      weight: cssWeight(bold),
    })
    await face.load()
    document.fonts.add(face)
  })()
  loading.set(key, promise)
  return promise
}

/**
 * Both weights of every body face.
 *
 * The bold half doubles this to ~680KB. It is still a preload rather than
 * an on-demand fetch because the alternative is text reflowing under the
 * caret the first time somebody ticks Bold.
 */
export function preloadFonts(): Promise<void[]> {
  return Promise.all(FONTS.flatMap((f) => [loadFont(f.family), loadFont(f.family, true)]))
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
 *
 * The weight is part of the measurement, not decoration on it: bold glyphs
 * are wider, so measuring a bold line as regular puts every centred and
 * right-aligned line off by a few points.
 */
export function measureText(
  text: string,
  family: string,
  size: number,
  bold?: boolean,
): number {
  if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return 0
  ctx.font = `${cssWeight(bold)} ${size}px ${cssFamily(family)}`
  return ctx.measureText(text).width
}

/** The raw file, for the worker to embed. Same bytes the browser rendered. */
export async function fontBytes(family: string, bold?: boolean): Promise<Uint8Array> {
  const res = await fetch(fontUrl(family, bold))
  if (!res.ok) throw new Error(`could not load the font "${family}" (${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * Every FACE an edit document will ask the writer for.
 *
 * ONE place that knows which object kinds carry a font, because there
 * were five call sites collecting them and each filtered on `kind ===
 * 'text'` alone. Phase 6 added three more kinds with a fontFamily --
 * stamps, text patches, and form fields -- and every one of those sites
 * silently stopped supplying what the export needed: adding a watermark
 * and pressing Download failed with "font Inter was not provided",
 * because the collection did not know stamps had fonts.
 *
 * A kind added later has to be added here, once, rather than in five
 * places nobody will remember to visit.
 *
 * Returns FACE keys and not families, for the same reason: a bold heading
 * needs Inter Bold embedded, and a collector that only knew about families
 * would hand the writer the regular and let it throw at Download time --
 * which is exactly the failure this function was written to end.
 */
export function facesUsed(objects: Iterable<EditObject>): string[] {
  const faces = new Set<string>()
  for (const object of objects) {
    const family = (object as { fontFamily?: unknown }).fontFamily
    if (typeof family !== 'string' || family === '') continue
    faces.add(faceKey(family, (object as { bold?: unknown }).bold === true))
  }
  return [...faces]
}

/**
 * Font bytes for every face the edit document actually uses, keyed the way
 * the writer looks them up. Loading all ten on every export would add
 * ~680KB of fetches for a document that uses one of them.
 */
export async function fontsForExport(
  faces: Iterable<string>,
): Promise<Map<string, Uint8Array>> {
  // Only embeddable faces. A signature script reaching here would mean a
  // TEXT object had been given one, which the picker cannot produce -- and
  // embedding it would silently add ~60KB to a document for a face the
  // writer was never meant to see.
  const embeddable = new Map<string, { family: string; bold: boolean }>()
  for (const f of FONTS) {
    embeddable.set(faceKey(f.family), { family: f.family, bold: false })
    embeddable.set(faceKey(f.family, true), { family: f.family, bold: true })
  }
  const unique = [...new Set(faces)].filter((f) => embeddable.has(f))
  const loaded = await Promise.all(
    unique.map(async (face) => {
      const { family, bold } = embeddable.get(face)!
      return [face, await fontBytes(family, bold)] as const
    }),
  )
  return new Map(loaded)
}
