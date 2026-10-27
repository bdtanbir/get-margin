import { reactive } from 'vue'
import { FONTS, matchFamily, untag, type FontFamily } from './fonts'

/**
 * What to draw an existing line in when the document's font is not one we
 * carry.
 *
 * `familyForFont` answers "is this one of ours?" and falls back to Inter
 * when it is not. That fallback is what made clicking a Cambria line turn
 * it into Inter: a serif letter silently redrawn in a sans. This module is
 * the honest version of the same question -- it says when the font is NOT
 * ours, and offers the closest faces we do have, so the user picks instead
 * of the editor guessing.
 */

export type FontSuggestion = {
  family: FontFamily
  /**
   * Metric-compatible with the original: same advance widths, so the
   * replacement takes the same room on the line. Shown as "Very similar".
   */
  verySimilar: boolean
}

/** How many faces the replacement dialog offers. */
export const SUGGESTION_COUNT = 5

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The PostScript name without its subset tag or serial number. */
const untagged = untag

/**
 * Proprietary and common faces, by the start of their squashed PostScript
 * name, and what we carry that looks most like each -- best first. A `*`
 * marks a metric-compatible stand-in.
 *
 * Longest key wins, so "helveticaneue" is not read as "helvetica" and
 * "notoserif" is not read as "noto".
 */
const KNOWN: ReadonlyArray<[string, readonly string[]]> = [
  ['cambria', ['Caladea*', 'Gelasio', 'Tinos', 'Source Serif 4', 'Merriweather']],
  ['calibri', ['Carlito*', 'Arimo', 'Roboto', 'Inter', 'Nunito']],
  ['lato', ['Carlito*', 'Roboto', 'Inter', 'Nunito', 'Arimo']],
  ['candara', ['Nunito', 'Carlito', 'Lexend', 'Roboto', 'Inter']],
  ['corbel', ['Carlito', 'Nunito', 'Lexend', 'Roboto', 'Inter']],
  ['constantia', ['Gelasio', 'Caladea', 'Source Serif 4', 'Lora', 'Merriweather']],
  ['helvetica', ['Arimo*', 'Roboto', 'Inter', 'Montserrat', 'Carlito']],
  ['helveticaneue', ['Arimo', 'Inter', 'Roboto', 'Montserrat', 'Carlito']],
  ['times', ['Tinos*', 'Caladea', 'Gelasio', 'Source Serif 4', 'EB Garamond']],
  ['courier', ['Cousine*', 'Roboto Mono', 'JetBrains Mono']],
  ['consolas', ['JetBrains Mono', 'Roboto Mono', 'Cousine']],
  ['menlo', ['JetBrains Mono', 'Roboto Mono', 'Cousine']],
  ['monaco', ['JetBrains Mono', 'Roboto Mono', 'Cousine']],
  ['lucidaconsole', ['Roboto Mono', 'JetBrains Mono', 'Cousine']],
  ['verdana', ['Inter', 'Roboto', 'Arimo', 'Nunito', 'Carlito']],
  ['tahoma', ['Inter', 'Roboto', 'Arimo', 'Nunito', 'Carlito']],
  ['segoeui', ['Roboto', 'Inter', 'Carlito', 'Arimo', 'Nunito']],
  ['opensans', ['Roboto', 'Inter', 'Arimo', 'Nunito', 'Carlito']],
  ['sourcesans', ['Roboto', 'Inter', 'Carlito', 'Arimo', 'Nunito']],
  ['myriad', ['Roboto', 'Carlito', 'Inter', 'Nunito', 'Arimo']],
  ['notosans', ['Roboto', 'Inter', 'Arimo', 'Nunito', 'Carlito']],
  ['notoserif', ['Roboto Serif', 'Source Serif 4', 'Tinos', 'Gelasio', 'Merriweather']],
  ['raleway', ['Montserrat', 'Poppins', 'Outfit', 'Lexend', 'Nunito']],
  ['centurygothic', ['Montserrat', 'Poppins', 'Outfit', 'Lexend', 'Comfortaa']],
  ['futura', ['Outfit', 'Poppins', 'Montserrat', 'Lexend', 'Nunito']],
  ['avenir', ['Nunito', 'Outfit', 'Montserrat', 'Poppins', 'Lexend']],
  ['gillsans', ['Lexend', 'Nunito', 'Carlito', 'Roboto', 'Inter']],
  ['franklingothic', ['Roboto', 'Arimo', 'Inter', 'Oswald', 'Montserrat']],
  ['garamond', ['EB Garamond*', 'Cormorant Garamond', 'Spectral', 'Lora', 'Source Serif 4']],
  ['adobegaramond', ['EB Garamond*', 'Cormorant Garamond', 'Spectral', 'Lora', 'Source Serif 4']],
  ['bookantiqua', ['Spectral', 'EB Garamond', 'Lora', 'Gelasio', 'Source Serif 4']],
  ['palatino', ['Spectral', 'EB Garamond', 'Lora', 'Gelasio', 'Source Serif 4']],
  ['minion', ['Source Serif 4', 'Spectral', 'EB Garamond', 'Lora', 'Tinos']],
  ['baskerville', ['EB Garamond', 'Spectral', 'Source Serif 4', 'Lora', 'Tinos']],
  ['bookman', ['Merriweather', 'Source Serif 4', 'Gelasio', 'Lora', 'Tinos']],
  ['centuryschoolbook', ['Gelasio', 'Merriweather', 'Source Serif 4', 'Tinos', 'Lora']],
  ['bodoni', ['Playfair Display', 'Spectral', 'Source Serif 4', 'EB Garamond', 'Lora']],
  ['didot', ['Playfair Display', 'Spectral', 'Source Serif 4', 'EB Garamond', 'Lora']],
  ['impact', ['Anton*', 'Oswald', 'Montserrat']],
  ['comicsans', ['Comic Neue*', 'Caveat', 'Nunito']],
]

/** When nothing is known about a face beyond what its name suggests. */
const BY_CLASS: Readonly<Record<'serif' | 'sans' | 'mono' | 'script', readonly string[]>> = {
  serif: ['Tinos', 'Caladea', 'Gelasio', 'Source Serif 4', 'Merriweather'],
  sans: ['Arimo', 'Carlito', 'Roboto', 'Inter', 'Montserrat'],
  mono: ['Cousine', 'JetBrains Mono', 'Roboto Mono'],
  script: ['Caveat', 'Pacifico', 'Lobster', 'Sacramento', 'Comic Neue'],
}

/**
 * Serif, sans, mono or script, read off the name alone.
 *
 * Only the name, because the font program's own serif flag is not
 * trustworthy on embedded TrueType (see `LineRun.italic`). "Sans" is
 * checked before "serif" so "NotoSansSerif"-style names and "Sans Serif"
 * land as sans.
 */
function classOf(bare: string): keyof typeof BY_CLASS {
  if (/mono|code|courier|consol|typewriter/.test(bare)) return 'mono'
  if (/script|hand|brush|callig|signature/.test(bare)) return 'script'
  if (/sans|gothic|grotesk|grotesque/.test(bare)) return 'sans'
  if (/serif|roman|times|garamond|antiqua|book|caslon|baskerville|bodoni|didot|georgia|cambria|minion|palatino|slab/.test(bare)) {
    return 'serif'
  }
  return 'sans'
}

const carried = new Set(FONTS.map((f) => f.family))

/**
 * The faces we carry that look most like a document's font, best first,
 * at most SUGGESTION_COUNT. Never empty.
 */
export function similarFonts(name: string): FontSuggestion[] {
  const bare = squash(untagged(name))
  let best: readonly string[] | undefined
  let length = 0
  for (const [key, list] of KNOWN) {
    if (bare.startsWith(key) && key.length > length) { best = list; length = key.length }
  }
  const ranked = [...(best ?? []), ...BY_CLASS[classOf(bare)], ...BY_CLASS.sans]
  const out: FontSuggestion[] = []
  for (const entry of ranked) {
    const verySimilar = entry.endsWith('*')
    const family = verySimilar ? entry.slice(0, -1) : entry
    if (!carried.has(family) || out.some((s) => s.family === family)) continue
    out.push({ family, verySimilar })
    if (out.length === SUGGESTION_COUNT) break
  }
  return out
}

/**
 * The key a remembered choice is stored under: the family part of the
 * PostScript name, without subset tag or style -- so choosing Caladea for
 * `BCDFEE+Cambria-Bold` also covers `ABCDEF+Cambria` on the next line.
 */
export function fontKey(name: string): string {
  return squash(untagged(name).split(/[-,]/)[0] ?? '')
}

/**
 * Replacements the user asked to "always use", for the rest of the
 * session. Reactive so the inspector and toolbar see a choice as soon as
 * it is made.
 */
const remembered = reactive(new Map<string, FontFamily>())

export function rememberReplacement(name: string, family: FontFamily): void {
  remembered.set(fontKey(name), family)
}

export function rememberedReplacement(name: string): FontFamily | undefined {
  return remembered.get(fontKey(name))
}

/** For tests. */
export function forgetReplacements(): void {
  remembered.clear()
}

/**
 * The family to draw an existing line in WITHOUT asking: ours if the
 * document's font is ours, the user's remembered choice if they made one,
 * otherwise the closest face we carry. Never Inter-by-default for a font
 * that is plainly something else.
 *
 * For the paths that cannot stop to ask -- Bold over a selection, Find and
 * Replace across a document. The inline editor asks instead; see
 * `needsReplacementChoice`.
 */
export function familyForLine(name: string): FontFamily {
  return matchFamily(name) ?? rememberedReplacement(name) ?? similarFonts(name)[0]!.family
}

/**
 * Whether editing a line in this font should ask the user which face to use.
 *
 * Only when we have nothing close. A font we carry, a choice the user
 * already made, or a metric-compatible twin (Calibri -> Carlito, Cambria ->
 * Caladea, Times -> Tinos...) is used straight away: the twin has the same
 * advance widths and near-identical shapes, so asking about it was a
 * dialog in front of nearly every Word document for no real decision.
 */
export function needsReplacementChoice(name: string): boolean {
  if (name === '') return false
  if (matchFamily(name) !== undefined || rememberedReplacement(name) !== undefined) return false
  return !similarFonts(name)[0]?.verySimilar
}
