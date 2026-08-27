import { nanoid } from 'nanoid'
import { hashText, type EditObject, type TextPatchObject } from '@margin/pdf-core'
import type { PageMatch } from '@/stores/find'
import type { BackgroundSample } from '@/features/patch/sampleBackground'

export type ReplacementContext = {
  /** The edit-document page id for a source page index, or undefined if it is gone. */
  pageIdFor: (sourcePage: number) => string | undefined
  /** The background behind a line, if it can be sampled. */
  sampleFor: (sourcePage: number, match: PageMatch) => BackgroundSample | undefined
  /**
   * The patch already covering a line, if the user has edited or moved it.
   *
   * Asked rather than assumed absent, which is what this used to do. See
   * the ONE PATCH PER LINE note below: the invariant was kept within a run
   * and broken across one.
   */
  patchOnLine: (pageId: string, lineIndex: number) => TextPatchObject | undefined
  fontFamily: string
  nextZ: () => number
}

/** A replacement folded into a patch the line already had. */
export type ReplacementUpdate = { id: string; text: string }

export type ReplacementPlan = {
  /** New patches, for lines that did not have one. */
  patches: TextPatchObject[]
  /**
   * Lines that already had a patch the replacement could safely go into.
   * Kept apart from `patches` because these must be applied as UPDATES --
   * adding them would be the duplicate this module exists to prevent.
   */
  updates: ReplacementUpdate[]
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
 * That held WITHIN a run and not ACROSS one. A match on a line the user
 * had already edited, styled or moved produced a second patch on top of
 * the first, and the first edit was discarded without a word -- the exact
 * failure the paragraph above describes, arrived at from the other
 * direction. So an existing patch is now consulted, and there are two
 * cases:
 *
 * Its text is still the document's own -- a pure move, or a style-only
 * edit. The offsets the search reported address the string that patch
 * holds, because they are the same string, so the replacement goes INTO
 * it and the move and the styling survive.
 *
 * Its text has been retyped. Those offsets now address characters of a
 * string that is no longer there, so applying them would splice the
 * replacement into the wrong place -- and quietly, because nothing about
 * the result would look wrong. The match is SKIPPED and reported. Making
 * this work would mean re-running the search against the patch's own text
 * with the user's case and whole-word settings, which is a different
 * feature and not one to arrive at by accident.
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
  const updates: ReplacementUpdate[] = []
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

    const existing = ctx.patchOnLine(pageId, first.lineIndex)
    if (existing) {
      if (existing.text === original) {
        // Same string, so the same offsets. Only the text changes: the
        // move, the weight, the size and the colour are the user's and
        // this is not the place they asked to change them.
        updates.push({ id: existing.id, text })
      } else {
        // One skip per MATCH, not per line, so the reported "replaced N of
        // M" still adds up.
        for (const match of group) {
          skipped.push({ match, reason: 'that line has already been edited' })
        }
      }
      // Either way no new patch, and no new background sample to judge --
      // the cover already on the line is the one that will be painted.
      continue
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
      // The weight and slope the line is already set in, so Replace All
      // does not un-bold or straighten every heading it touches. The match
      // carries them out of the extraction for exactly this.
      bold: first.bold,
      italic: first.italic,
      // The line's own size and pen position, for the same reason as the
      // weight: a patch built without them shows a zero in the inspector
      // and previews at the wrong height.
      fontSize: first.size,
      baseline: first.baseline,
      // The line's own fill. Replace All used to blacken every match it
      // touched, which on a document with any grey or coloured text is a
      // change nobody asked for on every row it changed.
      color: first.color,
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

  return { patches, updates, skipped, lowConfidence }
}

export const asEditObjects = (patches: TextPatchObject[]): EditObject[] => patches as EditObject[]
