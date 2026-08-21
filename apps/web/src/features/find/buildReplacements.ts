import { nanoid } from 'nanoid'
import { hashText, type EditObject, type TextPatchObject } from '@margin/pdf-core'
import type { PageMatch } from '@/stores/find'
import type { BackgroundSample } from '@/features/patch/sampleBackground'

export type ReplacementContext = {
  /** The edit-document page id for a source page index, or undefined if it is gone. */
  pageIdFor: (sourcePage: number) => string | undefined
  /** The background behind a line, if it can be sampled. */
  sampleFor: (sourcePage: number, match: PageMatch) => BackgroundSample | undefined
  fontFamily: string
  nextZ: () => number
}

export type ReplacementPlan = {
  patches: TextPatchObject[]
  /** Matches that could not become a patch, and why -- reported, not dropped. */
  skipped: Array<{ match: PageMatch; reason: string }>
  /** How many patches cover a line whose background could not be read confidently. */
  lowConfidence: number
}

/**
 * Turn find matches into text patches.
 *
 * ONE PATCH PER LINE, however many matches that line holds, and this is
 * the whole reason the function exists rather than a `map`. A patch covers
 * and rewrites its ENTIRE line, so two patches on one line would each
 * cover the whole thing and whichever drew second would win -- silently
 * discarding the other replacement. Replacing "the" in a line containing
 * it three times has to produce one patch with all three substituted, not
 * three patches that fight.
 *
 * Substitutions are applied RIGHT TO LEFT within each line, so an earlier
 * match's offsets are still valid after a later one has changed the
 * string's length.
 *
 * A match whose page has been deleted since the search is SKIPPED and
 * reported rather than dropped: the count the user was shown has to
 * reconcile with what happened, or "replaced 40 of 47" becomes an
 * unexplained silence.
 */
export function buildReplacements(
  matches: PageMatch[],
  replacement: string,
  ctx: ReplacementContext,
): ReplacementPlan {
  const byLine = new Map<string, PageMatch[]>()
  const skipped: ReplacementPlan['skipped'] = []

  for (const match of matches) {
    if (ctx.pageIdFor(match.page) === undefined) {
      skipped.push({ match, reason: 'that page is no longer in the document' })
      continue
    }
    const key = `${match.page}:${match.lineIndex}`
    const list = byLine.get(key)
    if (list) list.push(match)
    else byLine.set(key, [match])
  }

  const patches: TextPatchObject[] = []
  let lowConfidence = 0

  for (const group of byLine.values()) {
    const first = group[0]!
    const pageId = ctx.pageIdFor(first.page)!
    const original = first.lineText

    // Right to left, so earlier offsets survive later edits.
    const ordered = [...group].sort((a, b) => b.start - a.start)
    let text = original
    for (const match of ordered) {
      text = text.slice(0, match.start) + replacement + text.slice(match.end)
    }

    const sample = ctx.sampleFor(first.page, first)
    if ((sample?.confidence ?? 0) < 0.75) lowConfidence++

    // The bounding box of the line, from the quads of every match on it --
    // enough for the editor's own chrome. The WRITER re-derives the real
    // box from the page at export, so this is not load-bearing geometry.
    const xs = group.flatMap((m) => m.quads.flatMap((q) => [q[0], q[2], q[4], q[6]]))
    const ys = group.flatMap((m) => m.quads.flatMap((q) => [q[1], q[3], q[5], q[7]]))

    patches.push({
      id: nanoid(10),
      pageId,
      kind: 'textPatch',
      lineIndex: first.lineIndex,
      // Hashed from the line as the SEARCH saw it, which is what the user
      // was shown. The export compares against the document at that
      // moment and refuses if the two disagree.
      originalHash: hashText(original),
      originalText: original,
      text,
      fontFamily: ctx.fontFamily,
      // The weight the line is already set in, so Replace All does not
      // un-bold every heading it touches. The match carries it out of the
      // extraction for exactly this -- see Match.bold.
      bold: first.bold,
      fontSize: 0,
      color: [0, 0, 0],
      background: sample?.color ?? [1, 1, 1],
      backgroundConfidence: sample?.confidence ?? 0,
      fit: 'shrink',
      rect: {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
      },
      rotation: 0,
      z: ctx.nextZ(),
      locked: false,
      opacity: 1,
    })
  }

  return { patches, skipped, lowConfidence }
}

export const asEditObjects = (patches: TextPatchObject[]): EditObject[] => patches as EditObject[]
