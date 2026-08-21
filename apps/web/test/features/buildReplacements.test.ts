import { describe, it, expect } from 'vitest'
import { buildReplacements } from '@/features/find/buildReplacements'
import type { PageMatch } from '@/stores/find'
import type { Quad } from '@margin/pdf-core'

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
    size: 12,
    baseline: 14,
    quads: Array.from({ length: end - start }, (_, i) => quad(start + i)),
    ...over,
  }
}

const ctx = (over: Partial<Parameters<typeof buildReplacements>[2]> = {}) => ({
  pageIdFor: (p: number) => `p${p}`,
  sampleFor: () => ({ color: [1, 1, 1] as [number, number, number], confidence: 1, samples: 100 }),
  fontFamily: 'Inter',
  nextZ: () => 1,
  ...over,
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
})
