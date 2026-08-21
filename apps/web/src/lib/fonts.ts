import type { EditObject } from '@margin/pdf-core'
import { faceKey, type FaceStyle } from '@margin/pdf-core'

export { faceKey, type FaceStyle }

/**
 * The curated font set, shared by preview and export.
 *
 * Spec 2.5: the browser measures and renders with the SAME BYTES the worker
 * embeds into the exported PDF, self-hosted so opening a document makes no
 * third-party request. `file` is explicit rather than derived from `family`
 * -- "Source Serif 4" does not munge into "SourceSerif4" by any rule worth
 * maintaining, and a wrong guess is a 404 at export time.
 *
 * EVERY STYLE IS A SEPARATE FILE, not a flag. Asking the browser for
 * weight 700 or `font-style: italic` with only the upright regular
 * registered gets a SYNTHESISED face -- stroked outlines for bold, sheared
 * ones for italic -- and both keep the regular's advance widths, while the
 * export would embed a real face with different ones. The two would
 * disagree about where a centred line starts. Four files per family keeps
 * preview and export measuring the same glyphs, which is the whole point of
 * self-hosting them.
 *
 * Bold italic is its OWN file rather than the bold one on a slant, because
 * that is what a type designer draws: in a serif face the italic is a
 * different alphabet, not the roman leaning over.
 *
 * See public/fonts/LICENSES.md for provenance and licences.
 */
export const FONTS = [
  {
    family: 'Inter', fallback: 'sans-serif',
    file: 'Inter.ttf', bold: 'Inter-Bold.ttf',
    italic: 'Inter-Italic.ttf', boldItalic: 'Inter-BoldItalic.ttf',
  },
  {
    family: 'Roboto', fallback: 'sans-serif',
    file: 'Roboto.ttf', bold: 'Roboto-Bold.ttf',
    italic: 'Roboto-Italic.ttf', boldItalic: 'Roboto-BoldItalic.ttf',
  },
  {
    family: 'Source Serif 4', fallback: 'serif',
    file: 'SourceSerif4.ttf', bold: 'SourceSerif4-Bold.ttf',
    italic: 'SourceSerif4-Italic.ttf', boldItalic: 'SourceSerif4-BoldItalic.ttf',
  },
  {
    family: 'Merriweather', fallback: 'serif',
    file: 'Merriweather.ttf', bold: 'Merriweather-Bold.ttf',
    italic: 'Merriweather-Italic.ttf', boldItalic: 'Merriweather-BoldItalic.ttf',
  },
  {
    family: 'JetBrains Mono', fallback: 'monospace',
    file: 'JetBrainsMono.ttf', bold: 'JetBrainsMono-Bold.ttf',
    italic: 'JetBrainsMono-Italic.ttf', boldItalic: 'JetBrainsMono-BoldItalic.ttf',
  },
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
 * One style only: a signature is written in one hand, and a heavier or
 * slanted one is not a setting anybody reaches for -- a script face is
 * already slanted. The undefined variants also keep `faceFile` below honest
 * -- asking for a bold or italic script face fails rather than quietly
 * handing back the upright regular.
 */
export const SIGNATURE_FACES = [
  {
    family: 'Caveat', file: 'Caveat.ttf', fallback: 'cursive',
    bold: undefined, italic: undefined, boldItalic: undefined,
  },
  {
    family: 'Dancing Script', file: 'DancingScript.ttf', fallback: 'cursive',
    bold: undefined, italic: undefined, boldItalic: undefined,
  },
  {
    family: 'Great Vibes', file: 'GreatVibes.ttf', fallback: 'cursive',
    bold: undefined, italic: undefined, boldItalic: undefined,
  },
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

/** The `font-style` a face is registered and asked for under. */
export const cssStyle = (italic?: boolean): string => (italic ? 'italic' : 'normal')

/**
 * The file behind a family in a given style.
 *
 * Throws for a style a family has no file for -- a bold or italic script
 * face -- rather than falling back to its regular: a silent fallback here
 * would render one thing and embed another.
 */
export function faceFile(family: string, style?: FaceStyle): string {
  const f = entry(family)
  if (!f) throw new Error(`unknown font family "${family}"`)
  const wanted = style?.bold
    ? style.italic ? f.boldItalic : f.bold
    : style?.italic ? f.italic : f.file
  if (!wanted) {
    throw new Error(
      `"${family}" has no ${style?.bold ? 'bold ' : ''}${style?.italic ? 'italic ' : ''}face`,
    )
  }
  return wanted
}

export function fontUrl(family: string, style?: FaceStyle): string {
  return `/fonts/${faceFile(family, style)}`
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
 * All four styles register under the SAME CSS family name, distinguished by
 * the FontFace `weight` and `style` descriptors. That is what makes
 * `font-weight: 700` and `font-style: italic` in the overlay pick up
 * Inter-BoldItalic.ttf instead of asking the browser to fake it by stroking
 * and shearing the regular -- and a faked face measures at the regular's
 * advance widths while the export uses the real ones.
 *
 * Cached by FACE, not family: the text tool asks for the active face on
 * every keystroke, and FontFace construction plus load() is a fetch and a
 * parse.
 */
export function loadFont(family: string, style?: FaceStyle): Promise<void> {
  const key = faceKey(family, style)
  const hit = loading.get(key)
  if (hit) return hit
  const promise = (async () => {
    if (typeof FontFace === 'undefined' || !document.fonts) return
    const face = new FontFace(family, `url(${fontUrl(family, style)})`, {
      weight: cssWeight(style?.bold),
      style: cssStyle(style?.italic),
    })
    await face.load()
    document.fonts.add(face)
  })()
  loading.set(key, promise)
  return promise
}

/** The four combinations a bundled family has a file for. */
export const ALL_STYLES: FaceStyle[] = [
  {},
  { bold: true },
  { italic: true },
  { bold: true, italic: true },
]

/**
 * Every style of every body face.
 *
 * Four styles across five families is ~1.6MB, which is why this is not
 * called anywhere: faces load on demand through `loadFont`. Kept because
 * the alternative when it IS wanted is text reflowing under the caret the
 * first time somebody ticks Italic, and because a helper that enumerates
 * the set is the thing a preload would need.
 */
export function preloadFonts(): Promise<void[]> {
  return Promise.all(FONTS.flatMap((f) => ALL_STYLES.map((s) => loadFont(f.family, s))))
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
 * The style is part of the measurement, not decoration on it: bold glyphs
 * are wider and italic ones are usually narrower, so measuring a line in
 * the wrong face puts every centred and right-aligned line off by a few
 * points.
 *
 * The shorthand's order is fixed by CSS -- style, then weight, then size --
 * and a font shorthand the browser cannot parse is silently ignored, which
 * would leave the canvas measuring in its default face and report nothing.
 */
export function measureText(
  text: string,
  family: string,
  size: number,
  style?: FaceStyle,
): number {
  if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return 0
  ctx.font =
    `${cssStyle(style?.italic)} ${cssWeight(style?.bold)} ${size}px ${cssFamily(family)}`
  return ctx.measureText(text).width
}

/** The raw file, for the worker to embed. Same bytes the browser rendered. */
export async function fontBytes(family: string, style?: FaceStyle): Promise<Uint8Array> {
  const res = await fetch(fontUrl(family, style))
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
 * Returns FACE keys and not families, for the same reason: a bold italic
 * heading needs Inter Bold Italic embedded, and a collector that only knew
 * about families would hand the writer the regular and let it throw at
 * Download time -- which is exactly the failure this function was written
 * to end. The object is passed to `faceKey` whole, so a style axis added to
 * the format is collected here without this function changing.
 */
export function facesUsed(objects: Iterable<EditObject>): string[] {
  const faces = new Set<string>()
  for (const object of objects) {
    const family = (object as { fontFamily?: unknown }).fontFamily
    if (typeof family !== 'string' || family === '') continue
    faces.add(faceKey(family, object as FaceStyle))
  }
  return [...faces]
}

/**
 * Font bytes for every face the edit document actually uses, keyed the way
 * the writer looks them up. Loading all twenty on every export would add
 * ~1.6MB of fetches for a document that uses one of them.
 */
export async function fontsForExport(
  faces: Iterable<string>,
): Promise<Map<string, Uint8Array>> {
  // Only embeddable faces. A signature script reaching here would mean a
  // TEXT object had been given one, which the picker cannot produce -- and
  // embedding it would silently add ~60KB to a document for a face the
  // writer was never meant to see.
  const embeddable = new Map<string, { family: string; style: FaceStyle }>()
  for (const f of FONTS) {
    for (const style of ALL_STYLES) {
      embeddable.set(faceKey(f.family, style), { family: f.family, style })
    }
  }
  const unique = [...new Set(faces)].filter((f) => embeddable.has(f))
  const loaded = await Promise.all(
    unique.map(async (face) => {
      const { family, style } = embeddable.get(face)!
      return [face, await fontBytes(family, style)] as const
    }),
  )
  return new Map(loaded)
}
