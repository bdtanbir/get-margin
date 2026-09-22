import type { EditObject } from '@margin/pdf-core'
import { faceKey, nearestWeight, weightOf, REGULAR_WEIGHT, type FaceStyle } from '@margin/pdf-core'
import catalog from './fontCatalog.json'

export { faceKey, type FaceStyle }

/**
 * One family in the curated set: what it is called, where its files are,
 * and which faces it actually has.
 *
 * `weights` and `italic` are the family's REAL coverage, not a promise:
 * Lobster is one upright file, Merriweather starts at 300, and asking for
 * a face a family does not have is a thrown error rather than the nearest
 * one. `fitStyle` is the place that snaps, and it is called where the user
 * changes family -- not here, where a silent substitute would render one
 * face and embed another.
 *
 * `alias` is the proprietary face this family is the metric-compatible
 * open stand-in for: Arimo for Arial, Tinos for Times New Roman. Google
 * Docs offers those names and cannot be served their files, so the picker
 * shows both -- "Arimo (Arial)" -- and the document embeds the one it
 * legally can.
 */
export type FontEntry = {
  family: string
  base: string
  fallback: string
  weights: readonly number[]
  italic: boolean
  alias?: string
}

/**
 * The curated font set, shared by preview and export.
 *
 * Spec 2.5: the browser measures and renders with the SAME BYTES the worker
 * embeds into the exported PDF, self-hosted so opening a document makes no
 * third-party request. The catalogue is a JSON file rather than a literal
 * here because the fetch script reads the same one: a family added there
 * is fetched, offered and embedded from a single definition, and a file
 * named by one rule and fetched by another is a 404 at export time.
 *
 * EVERY FACE IS A SEPARATE FILE, not a flag. Asking the browser for weight
 * 500 or `font-style: italic` with only the regular registered gets a
 * SYNTHESISED face -- stroked outlines for weight, sheared ones for italic
 * -- and both keep the regular's advance widths, while the export would
 * embed a real face with different ones. The two would disagree about
 * where a centred line starts. One file per weight per slope keeps preview
 * and export measuring the same glyphs, which is the whole point of
 * self-hosting them.
 *
 * See public/fonts/LICENSES.md for provenance and licences.
 */
export const FONTS: readonly FontEntry[] = catalog.families

/**
 * Script faces for the TYPED SIGNATURE (Task 35 Step 4).
 *
 * Caveat is a body face too -- Google Docs offers it as one -- so it is
 * in FONTS and reachable from the text tool. Dancing Script and Great Vibes
 * are browser-only: a typed signature is rasterised to a transparent PNG
 * and placed as an image, so the face never needs embedding and never
 * costs a document its font program. Keeping them out of FONTS also keeps
 * them out of the text tool's picker, where a signature script is not what
 * anyone wants for body copy.
 *
 * Self-hosted for the same reason as FONTS (spec 2.5): no third-party
 * request when a document is opened.
 */
export const SIGNATURE_FACES: readonly FontEntry[] = [
  ...FONTS.filter((f) => f.family === 'Caveat'),
  ...catalog.signature,
]

/** The faces that exist ONLY for signatures, and must never reach the writer. */
const SCRIPT_ONLY: readonly FontEntry[] = catalog.signature

/** Every face this app can load, whether or not it is embeddable. */
const ALL_FACES: readonly FontEntry[] = [...FONTS, ...SCRIPT_ONLY]

export type FontFamily = string

export const DEFAULT_FAMILY: FontFamily = 'Inter'

/**
 * These must stay equal to ASCENT_RATIO / LINE_HEIGHT in
 * pdf-core/src/write/objects/text.ts. The overlay lays text out with these
 * numbers and the writer lays it out with those; a mismatch is text that
 * jumps the moment the document is exported.
 */
export const ASCENT_RATIO = 0.8
export const LINE_HEIGHT = 1.2

const entry = (family: string): FontEntry | undefined =>
  ALL_FACES.find((f) => f.family === family)

/**
 * What the weights are called, for the picker. CSS's own names, which are
 * also what the type designers call them.
 */
export const WEIGHT_NAMES: Readonly<Record<number, string>> = {
  100: 'Thin',
  200: 'Extra Light',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'Semi Bold',
  700: 'Bold',
  800: 'Extra Bold',
}

/** The weights a family has a file for. Empty for an unknown family. */
export function weightsOf(family: string): readonly number[] {
  return entry(family)?.weights ?? []
}

/** Whether a family has italic files at all. */
export function hasItalic(family: string): boolean {
  return entry(family)?.italic ?? false
}

/** What the picker calls a family: its own name, and the face it stands in for. */
export function familyLabel(f: FontEntry): string {
  return f.alias ? `${f.family} (${f.alias})` : f.family
}

/**
 * `style`, adjusted to a face `family` actually has.
 *
 * The weight snaps to the nearest the family offers and italic is dropped
 * if the family has none. This is what a FAMILY CHANGE goes through, so
 * moving a 300 heading from Inter to Merriweather lands it at 300 and
 * moving it to Lobster lands it at 400 upright, in the same undo step --
 * rather than leaving an object the writer will refuse to draw.
 *
 * Returns only the keys that CHANGED, so a caller can spread it into a
 * patch without rewriting a weight that was already fine.
 */
export function fitStyle(family: string, style: FaceStyle): Partial<FaceStyle> {
  const f = entry(family)
  if (!f) return {}
  const out: Partial<FaceStyle> = {}
  const weight = weightOf(style)
  const fitted = nearestWeight(weight, f.weights)
  if (fitted !== weight) out.weight = fitted
  if (style.italic && !f.italic) out.italic = false
  return out
}

/**
 * The CSS `font-weight` a face is registered and asked for under.
 *
 * One function rather than the number spelled at each site, because it has
 * to be identical in three places -- the FontFace descriptor, the canvas
 * measurement string, and the SVG/DOM that renders -- or the browser
 * synthesises a weight instead of using the file we shipped, and nothing
 * says so.
 */
export const cssWeight = (weight?: number): string => String(weight ?? REGULAR_WEIGHT)

/** The `font-style` a face is registered and asked for under. */
export const cssStyle = (italic?: boolean): string => (italic ? 'italic' : 'normal')

/**
 * The file behind a family in a given style.
 *
 * Throws for a style a family has no file for -- a 100 Merriweather, an
 * italic Lobster -- rather than falling back to the nearest: a silent
 * fallback here would render one thing and embed another. `fitStyle` is
 * where snapping happens, and it happens where the user can see it.
 */
export function faceFile(family: string, style?: FaceStyle): string {
  const f = entry(family)
  if (!f) throw new Error(`unknown font family "${family}"`)
  const weight = weightOf(style)
  const italic = style?.italic === true
  if (!f.weights.includes(weight) || (italic && !f.italic)) {
    throw new Error(
      `"${family}" has no ${weight}${italic ? ' italic' : ''} face`,
    )
  }
  return `${f.base}-${weight}${italic ? 'Italic' : ''}.ttf`
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
 * Every face of a family registers under the SAME CSS family name,
 * distinguished by the FontFace `weight` and `style` descriptors. That is
 * what makes `font-weight: 500` and `font-style: italic` in the overlay
 * pick up Inter-500Italic.ttf instead of asking the browser to fake it by
 * stroking and shearing the regular -- and a faked face measures at the
 * regular's advance widths while the export uses the real ones.
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
      weight: cssWeight(style?.weight),
      style: cssStyle(style?.italic),
    })
    await face.load()
    document.fonts.add(face)
  })()
  loading.set(key, promise)
  return promise
}

/** Every style a family has a file for: each weight, upright and (if any) italic. */
export function stylesOf(family: string): FaceStyle[] {
  const f = entry(family)
  if (!f) return []
  return f.weights.flatMap((weight) =>
    f.italic ? [{ weight }, { weight, italic: true }] : [{ weight }],
  )
}

/**
 * Every style of every body face.
 *
 * Over two hundred files, which is why this is not called anywhere: faces
 * load on demand through `loadFont`. Kept because the alternative when it
 * IS wanted is text reflowing under the caret the first time somebody
 * picks a weight, and because a helper that enumerates the set is the
 * thing a preload would need.
 */
export function preloadFonts(): Promise<void[]> {
  return Promise.all(FONTS.flatMap((f) => stylesOf(f.family).map((s) => loadFont(f.family, s))))
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
 * The style is part of the measurement, not decoration on it: heavier
 * glyphs are wider and italic ones are usually narrower, so measuring a
 * line in the wrong face puts every centred and right-aligned line off by
 * a few points.
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
    `${cssStyle(style?.italic)} ${cssWeight(style?.weight)} ${size}px ${cssFamily(family)}`
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
 * Returns FACE keys and not families, for the same reason: a 700 italic
 * heading needs Inter 700 Italic embedded, and a collector that only knew
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
 * Every embeddable face, by the key the writer looks it up under. Built
 * once: it is a couple of hundred entries, and every export consults it.
 */
const EMBEDDABLE: ReadonlyMap<string, { family: string; style: FaceStyle }> = (() => {
  const map = new Map<string, { family: string; style: FaceStyle }>()
  for (const f of FONTS) {
    for (const style of stylesOf(f.family)) {
      map.set(faceKey(f.family, style), { family: f.family, style })
    }
  }
  return map
})()

/**
 * Font bytes for every face the edit document actually uses, keyed the way
 * the writer looks them up. Loading every file on every export would add
 * megabytes of fetches for a document that uses one of them.
 */
export async function fontsForExport(
  faces: Iterable<string>,
): Promise<Map<string, Uint8Array>> {
  // Only embeddable faces. A signature-only script reaching here would
  // mean a TEXT object had been given one, which the picker cannot
  // produce -- and embedding it would silently add ~60KB to a document for
  // a face the writer was never meant to see.
  const unique = [...new Set(faces)].filter((f) => EMBEDDABLE.has(f))
  const loaded = await Promise.all(
    unique.map(async (face) => {
      const { family, style } = EMBEDDABLE.get(face)!
      return [face, await fontBytes(family, style)] as const
    }),
  )
  return new Map(loaded)
}
