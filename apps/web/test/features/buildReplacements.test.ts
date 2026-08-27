import { describe, it, expect } from 'vitest'
import { buildReplacements } from '@/features/find/buildReplacements'
import type { PageMatch } from '@/stores/find'
import type { Quad, TextPatchObject } from '@margin/pdf-core'

const quad = (i: number): Quad => [i * 10, 0, i * 10 + 10, 0, i * 10, 18, i * 10 + 10, 18]

function match(over: Partial<PageMatch> = {}): PageMatch {
  const lineText = over.lineText ?? 'the cat sat on the mat'
  const start = over.start ?? 0
  const end = over.end ?? 3
  return {
    page: 0,
    lineIndex: 0,
    start,
    end,
    text: lineText.slice(start, end),
    lineText,
    bold: false,
    italic: false,
    size: 12,
    baseline: 14,
    color: [0, 0, 0],
    quads: Array.from({ length: end - start }, (_, i) => quad(start + i)),
    ...over,
  }
}

const ctx = (over: Partial<Parameters<typeof buildReplacements>[2]> = {}) => ({
  pageIdFor: (p: number) => `p${p}`,
  sampleFor: () => ({ color: [1, 1, 1] as [number, number, number], confidence: 1, samples: 100 }),
  // The default is "nothing on this line yet", which is what every case
  // below except the already-patched block is about.
  patchOnLine: () => undefined,
  fontFamily: 'Inter',
  nextZ: () => 1,
  ...over,
})

/**
 * A patch already on the line the search matched.
 *
 * ONE PATCH PER LINE is the invariant this whole module exists to keep,
 * and it was only ever kept WITHIN a run: two matches on one line made one
 * patch, and a match on a line the user had already edited made a second
 * patch on top of the first. Both cover the whole line and redraw it, so
 * whichever the writer reached second won -- silently discarding the
 * other, on screen and in the export.
 */
describe('buildReplacements over a line that is already patched', () => {
  const existing = (over: Partial<TextPatchObject> = {}): TextPatchObject => ({
    id: 'tp1', pageId: 'p0', kind: 'textPatch',
    lineIndex: 0,
    originalHash: 'h', originalText: 'the cat sat on the mat',
    text: 'the cat sat on the mat',
    fontFamily: 'Inter', bold: true, italic: false, fontSize: 12, baseline: 14,
    color: [0, 0, 0], background: [1, 1, 1], backgroundConfidence: 1,
    fit: 'overflow',
    rect: { x: 0, y: 0, w: 220, h: 18 },
    rotation: 0, z: 1, locked: false, opacity: 1,
    ...over,
  })

  const withExisting = (patch: TextPatchObject | undefined) =>
    ctx({ patchOnLine: () => patch })

  it('adds no second patch to the line', () => {
    const plan = buildReplacements([match()], 'a', withExisting(existing()))
    expect(plan.patches).toHaveLength(0)
  })

  /**
   * A patch whose text is still the document's own -- a pure MOVE, or a
   * style-only edit -- was matched at offsets that are still valid,
   * because the string the search read is the string the patch holds. So
   * the replacement goes into that patch, and everything the user did to
   * it survives.
   */
  it('puts the replacement into a patch that has only been moved', () => {
    const plan = buildReplacements([match()], 'a', withExisting(existing({
      offset: { dx: 40, dy: 20 },
    })))
    expect(plan.updates).toEqual([{ id: 'tp1', text: 'a cat sat on the mat' }])
    expect(plan.skipped).toHaveLength(0)
  })

  it('substitutes every match on the line, right to left, as it does for a new patch', () => {
    const plan = buildReplacements(
      [match({ start: 0, end: 3 }), match({ start: 15, end: 18 })],
      'a',
      withExisting(existing()),
    )
    expect(plan.updates).toEqual([{ id: 'tp1', text: 'a cat sat on a mat' }])
  })

  /**
   * The offsets came from the SOURCE line. Once the user has retyped it
   * they address characters of a string that is no longer there, so
   * applying them would cut the replacement into the wrong place -- and
   * quietly, since nothing about the result would look wrong.
   */
  it('refuses a line whose text the user has already changed', () => {
    const plan = buildReplacements([match()], 'a', withExisting(existing({
      text: 'something else entirely',
    })))
    expect(plan.patches).toHaveLength(0)
    expect(plan.updates).toHaveLength(0)
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0]!.reason).toMatch(/already been edited/i)
  })

  it('reports one skip per match, so the count the user was shown reconciles', () => {
    const plan = buildReplacements(
      [match({ start: 0, end: 3 }), match({ start: 15, end: 18 })],
      'a',
      withExisting(existing({ text: 'something else entirely' })),
    )
    expect(plan.skipped).toHaveLength(2)
  })

  /** An updated patch was never re-sampled, so it cannot be newly risky. */
  it('does not count an update as a low-confidence cover', () => {
    const plan = buildReplacements([match()], 'a', ctx({
      patchOnLine: () => existing(),
      sampleFor: () => undefined,
    }))
    expect(plan.lowConfidence).toBe(0)
  })

  it('leaves a line with no patch on the ordinary path', () => {
    const plan = buildReplacements([match()], 'a', withExisting(undefined))
    expect(plan.patches).toHaveLength(1)
    expect(plan.updates).toHaveLength(0)
  })

  /** Same line index, different page: a different line entirely. */
  it('asks about the line on the page the match is actually on', () => {
    const asked: Array<[string, number]> = []
    buildReplacements([match({ page: 1, lineIndex: 4 })], 'a', ctx({
      patchOnLine: (pageId: string, lineIndex: number) => {
        asked.push([pageId, lineIndex])
        return undefined
      },
    }))
    expect(asked).toEqual([['p1', 4]])
  })
})

describe('buildReplacements', () => {
  it('turns one match into one patch', () => {
    const plan = buildReplacements([match()], 'a', ctx())
    expect(plan.patches).toHaveLength(1)
    expect(plan.patches[0]!.text).toBe('a cat sat on the mat')
  })

  it('carries the line’s original text and its hash', () => {
    const plan = buildReplacements([match()], 'a', ctx())
    expect(plan.patches[0]!.originalText).toBe('the cat sat on the mat')
    expect(plan.patches[0]!.originalHash).toHaveLength(8)
  })

  /**
   * THE REASON THIS IS NOT A MAP. A patch covers and rewrites its ENTIRE
   * line, so two patches on one line would each cover the whole thing and
   * whichever drew second would win -- silently discarding the other
   * replacement.
   */
  it('makes ONE patch for a line containing several matches', () => {
    const line = 'the cat sat on the mat'
    const plan = buildReplacements([
      match({ lineText: line, start: 0, end: 3 }),
      match({ lineText: line, start: 15, end: 18 }),
    ], 'a', ctx())

    expect(plan.patches).toHaveLength(1)
    expect(plan.patches[0]!.text).toBe('a cat sat on a mat')
  })

  /**
   * Right to left, so an earlier match's offsets are still valid after a
   * later one has changed the string's length. Left to right with a longer
   * replacement corrupts every subsequent position.
   */
  it('keeps offsets valid when the replacement is longer than the match', () => {
    const line = 'the cat sat on the mat'
    const plan = buildReplacements([
      match({ lineText: line, start: 0, end: 3 }),
      match({ lineText: line, start: 15, end: 18 }),
    ], 'SOMETHING LONGER', ctx())

    expect(plan.patches[0]!.text).toBe('SOMETHING LONGER cat sat on SOMETHING LONGER mat')
  })

  it('keeps offsets valid when the replacement is shorter', () => {
    const line = 'the cat sat on the mat'
    const plan = buildReplacements([
      match({ lineText: line, start: 0, end: 3 }),
      match({ lineText: line, start: 15, end: 18 }),
    ], 'a', ctx())
    expect(plan.patches[0]!.text).toBe('a cat sat on a mat')
  })

  it('handles three matches on one line', () => {
    const line = 'aa bb aa cc aa'
    const plan = buildReplacements([
      match({ lineText: line, start: 0, end: 2 }),
      match({ lineText: line, start: 6, end: 8 }),
      match({ lineText: line, start: 12, end: 14 }),
    ], 'XX', ctx())
    expect(plan.patches).toHaveLength(1)
    expect(plan.patches[0]!.text).toBe('XX bb XX cc XX')
  })

  it('makes separate patches for separate lines', () => {
    const plan = buildReplacements([
      match({ lineIndex: 0, lineText: 'the first' }),
      match({ lineIndex: 1, lineText: 'the second' }),
    ], 'a', ctx())
    expect(plan.patches).toHaveLength(2)
    expect(plan.patches.map((p) => p.lineIndex).sort()).toEqual([0, 1])
  })

  it('makes separate patches for the same line on different pages', () => {
    const plan = buildReplacements([
      match({ page: 0, lineText: 'the one' }),
      match({ page: 1, lineText: 'the one' }),
    ], 'a', ctx())
    expect(plan.patches).toHaveLength(2)
    expect(plan.patches.map((p) => p.pageId).sort()).toEqual(['p0', 'p1'])
  })

  it('can delete text by replacing with nothing', () => {
    const plan = buildReplacements([match()], '', ctx())
    expect(plan.patches[0]!.text).toBe(' cat sat on the mat')
  })

  /**
   * A count the user was shown has to reconcile with what happened, or
   * "replaced 40 of 47" becomes an unexplained silence.
   */
  it('reports a match whose page is gone rather than dropping it', () => {
    const plan = buildReplacements(
      [match({ page: 0 }), match({ page: 9, lineText: 'the gone' })],
      'a',
      ctx({ pageIdFor: (p: number) => (p === 9 ? undefined : `p${p}`) }),
    )
    expect(plan.patches).toHaveLength(1)
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0]!.reason).toMatch(/no longer in the document/)
  })

  it('counts lines whose background could not be read confidently', () => {
    const plan = buildReplacements(
      [match({ lineIndex: 0, lineText: 'the a' }), match({ lineIndex: 1, lineText: 'the b' })],
      'x',
      ctx({
        sampleFor: (_p: number, m: PageMatch) =>
          m.lineIndex === 1
            ? { color: [0.5, 0.5, 0.5] as [number, number, number], confidence: 0.2, samples: 50 }
            : { color: [1, 1, 1] as [number, number, number], confidence: 1, samples: 50 },
      }),
    )
    expect(plan.lowConfidence).toBe(1)
  })

  it('treats an unsampleable page as low confidence rather than white', () => {
    const plan = buildReplacements([match()], 'a', ctx({ sampleFor: () => undefined }))
    expect(plan.lowConfidence).toBe(1)
    expect(plan.patches[0]!.backgroundConfidence).toBe(0)
  })

  it('does nothing with no matches', () => {
    const plan = buildReplacements([], 'a', ctx())
    expect(plan.patches).toEqual([])
    expect(plan.skipped).toEqual([])
  })

  it('gives every patch a distinct id', () => {
    const plan = buildReplacements([
      match({ lineIndex: 0, lineText: 'the a' }),
      match({ lineIndex: 1, lineText: 'the b' }),
    ], 'x', ctx())
    expect(new Set(plan.patches.map((p) => p.id)).size).toBe(2)
  })

  /**
   * Replace All used to blacken every match it touched. On any document
   * with grey or coloured text that is an unasked-for change on every row
   * it changed -- and unlike the patch editor, where the user is looking at
   * one line, it happens to dozens at once and out of view.
   */
  it('keeps each line’s own colour, weight, slope, and size', () => {
    const plan = buildReplacements(
      [match({
        color: [0.42, 0.45, 0.5], bold: true, italic: true, size: 9, baseline: 20,
      })],
      'a',
      ctx(),
    )
    const patch = plan.patches[0]!
    expect(patch.color).toEqual([0.42, 0.45, 0.5])
    expect(patch.bold).toBe(true)
    expect(patch.italic).toBe(true)
    expect(patch.fontSize).toBe(9)
    expect(patch.baseline).toBe(20)
  })
})
