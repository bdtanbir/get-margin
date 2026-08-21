import type { PageQuadIndex, Quad } from './index.js'

export type FindOptions = {
  caseSensitive?: boolean
  wholeWord?: boolean
}

export type Match = {
  /** Index of the line within the page's quad index. */
  lineIndex: number
  /** Character offsets into the line's ORIGINAL text. */
  start: number
  end: number
  /** The matched text as it appears in the document. */
  text: string
  /**
   * The WHOLE line the match sits in.
   *
   * Carried because replacement is line-level (PLAN.md 2.4 chose
   * line/span patching), so acting on a match means rewriting its line --
   * and re-deriving the line from a page index the caller may not have is
   * work the search has already done.
   */
  lineText: string
  /**
   * Whether the line is set in a bold face.
   *
   * Carried for the same reason as `lineText`: Replace All turns a match
   * into a text patch, and a patch that does not know the line was bold
   * redraws it regular. Find and the patch editor must produce the same
   * replacement for the same line, and this is what makes them.
   */
  bold: boolean
  /** One quad per matched character, for highlighting. */
  quads: Quad[]
}

/**
 * Characters that a PDF may render as one glyph but a user will type as
 * several.
 *
 * A search that misses "difficult" because the file stored "di<ffi>cult" is
 * not a search anybody trusts, and ligatures are the common case rather
 * than an exotic one -- most serif text faces substitute them automatically.
 */
const LIGATURES: Record<string, string> = {
  'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl',
  'ﬅ': 'st', 'ﬆ': 'st',
}

/**
 * Characters that mean the same thing but are not the same codepoint.
 *
 * Typographic quotes and dashes are what a PDF actually contains; straight
 * quotes and hyphens are what a keyboard produces. Someone searching for
 * "don't" should find "don’t".
 */
const EQUIVALENTS: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '−': '-',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
}

/**
 * Fold one character into the sequence a searcher would type for it.
 *
 * Returns a STRING because the mapping is one-to-many: a single ligature
 * glyph becomes two or three characters, which is what makes the offset
 * bookkeeping below necessary rather than optional.
 */
function fold(ch: string, caseSensitive: boolean): string {
  const ligature = LIGATURES[ch]
  if (ligature) return caseSensitive ? ligature : ligature.toLowerCase()
  const equivalent = EQUIVALENTS[ch] ?? ch
  return caseSensitive ? equivalent : equivalent.toLowerCase()
}

/**
 * A line's text folded for searching, plus a map back to the original.
 *
 * `origin[i]` is the index in the ORIGINAL string that folded character `i`
 * came from. Without it a match found in folded space could not be turned
 * back into character quads -- and a ligature makes the two strings
 * different lengths, so the offsets genuinely do drift.
 */
function foldLine(text: string, caseSensitive: boolean): { folded: string; origin: number[] } {
  let folded = ''
  const origin: number[] = []
  for (let i = 0; i < text.length; i++) {
    const mapped = fold(text[i]!, caseSensitive)
    for (const _ of mapped) origin.push(i)
    folded += mapped
  }
  return { folded, origin }
}

const WORD = /[\p{L}\p{N}_]/u

/**
 * Find every occurrence of `query` on a page.
 *
 * Searches LINE BY LINE rather than across the whole page, because a
 * "line" in the quad index is a homogeneous run with its own geometry, and
 * a match spanning two of them has no single set of quads to highlight.
 * The cost is that a phrase broken across a line break is missed -- which
 * is the same limitation every PDF reader has, and a smaller lie than
 * highlighting the wrong region.
 *
 * Normalisation is not optional decoration: `PLAN.md` §2.3 notes that PDFs
 * break words across spans, use ligatures, and space irregularly, so a
 * naive `indexOf` misses most real matches.
 */
export function findInPage(
  index: PageQuadIndex,
  query: string,
  options: FindOptions = {},
): Match[] {
  const caseSensitive = options.caseSensitive === true
  if (query === '') return []

  // The query is folded the same way the text is, so a user who types a
  // ligature or a curly quote is treated exactly like one who does not.
  const { folded: needle } = foldLine(query, caseSensitive)
  if (needle === '') return []

  const matches: Match[] = []

  index.lines.forEach((line, lineIndex) => {
    const source = line.chars.map((c) => c.char).join('')
    const { folded, origin } = foldLine(source, caseSensitive)

    let from = 0
    for (;;) {
      const at = folded.indexOf(needle, from)
      if (at === -1) break

      const start = origin[at]!
      // The character AFTER the match, in original coordinates. Using the
      // last matched character's origin +1 rather than origin[at+len]
      // keeps a match ending at the line's end in range.
      const lastFolded = at + needle.length - 1
      const end = (origin[lastFolded] ?? source.length - 1) + 1

      if (!options.wholeWord || isWholeWord(source, start, end)) {
        matches.push({
          lineIndex,
          start,
          end,
          text: source.slice(start, end),
          lineText: source,
          bold: line.bold,
          quads: line.chars.slice(start, end).map((c) => c.quad),
        })
      }
      // Advance past this match's START, not its end, so overlapping
      // occurrences of a self-overlapping query ("aa" in "aaa") are all
      // found rather than every other one.
      from = at + 1
    }
  })

  return matches
}

function isWholeWord(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1]! : ''
  const after = end < text.length ? text[end]! : ''
  return !WORD.test(before) && !WORD.test(after)
}
