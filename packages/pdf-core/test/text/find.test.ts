import { describe, it, expect } from 'vitest'
import { findInPage } from '../../src/text/find.js'
import type { PageQuadIndex, Quad } from '../../src/text/index.js'

/** A page index whose lines are the given strings, one quad per character. */
function pageOf(...lines: string[]): PageQuadIndex {
  return {
    lines: lines.map((text, li) => ({
      bbox: [0, li * 20, text.length * 10, li * 20 + 18] as [number, number, number, number],
      text,
      font: 'Test',
      size: 12,
      chars: [...text].map((char, i) => ({
        char,
        quad: [
          i * 10, li * 20, i * 10 + 10, li * 20,
          i * 10, li * 20 + 18, i * 10 + 10, li * 20 + 18,
        ] as Quad,
      })),
    })),
  }
}

const texts = (index: PageQuadIndex, q: string, o = {}) =>
  findInPage(index, q, o).map((m) => m.text)

describe('findInPage', () => {
  it('finds a simple match', () => {
    const found = findInPage(pageOf('hello world'), 'world')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ lineIndex: 0, start: 6, end: 11, text: 'world' })
  })

  it('finds every occurrence', () => {
    expect(texts(pageOf('cat and cat and cat'), 'cat')).toHaveLength(3)
  })

  it('searches every line', () => {
    const found = findInPage(pageOf('first line', 'second line'), 'line')
    expect(found.map((m) => m.lineIndex)).toEqual([0, 1])
  })

  it('returns one quad per matched character, for highlighting', () => {
    const found = findInPage(pageOf('hello world'), 'world')
    expect(found[0]!.quads).toHaveLength(5)
    // The first quad is the 'w', at x = 6 * 10.
    expect(found[0]!.quads[0]![0]).toBe(60)
  })

  it('finds nothing for a query that is not there', () => {
    expect(findInPage(pageOf('hello'), 'goodbye')).toEqual([])
  })

  it('finds nothing for an empty query', () => {
    expect(findInPage(pageOf('hello'), '')).toEqual([])
  })
})

describe('case', () => {
  it('ignores case by default', () => {
    expect(texts(pageOf('Hello World'), 'hello world')).toEqual(['Hello World'])
  })

  it('respects case when asked', () => {
    expect(findInPage(pageOf('Hello'), 'hello', { caseSensitive: true })).toEqual([])
    expect(texts(pageOf('Hello'), 'Hello', { caseSensitive: true })).toEqual(['Hello'])
  })

  it('returns the text as the DOCUMENT has it, not as it was typed', () => {
    expect(texts(pageOf('Hello'), 'hello')).toEqual(['Hello'])
  })
})

/**
 * THE REASON THIS IS NOT indexOf. A search that misses "difficult" because
 * the file stored a ligature is not a search anybody trusts, and most serif
 * faces substitute them automatically.
 */
describe('ligatures', () => {
  it('finds a word the document stored with a ligature', () => {
    expect(texts(pageOf('diﬃcult'), 'difficult')).toEqual(['diﬃcult'])
  })

  it('finds it when the query uses the ligature instead', () => {
    expect(texts(pageOf('difficult'), 'diﬃcult')).toEqual(['difficult'])
  })

  it('handles fi, fl, ff and the three-letter forms', () => {
    expect(texts(pageOf('ﬁnd'), 'find')).toEqual(['ﬁnd'])
    expect(texts(pageOf('ﬂow'), 'flow')).toEqual(['ﬂow'])
    expect(texts(pageOf('oﬀer'), 'offer')).toEqual(['oﬀer'])
  })

  /**
   * A ligature is one character in the document and two or three in the
   * query, so the offsets genuinely drift -- which is what the origin map
   * exists for. If it were wrong, the quads would highlight the wrong
   * glyphs rather than the match failing outright.
   */
  it('maps back to the right characters despite the length change', () => {
    const found = findInPage(pageOf('a diﬃcult word'), 'difficult')
    expect(found).toHaveLength(1)
    expect(found[0]!.start).toBe(2)
    // Seven characters in the document: d, i, ffi, c, u, l, t.
    expect(found[0]!.quads).toHaveLength(7)
    expect(found[0]!.text).toBe('diﬃcult')
  })
})

/**
 * Typographic quotes and dashes are what a PDF contains; straight ones are
 * what a keyboard produces.
 */
describe('typographic equivalents', () => {
  it('matches a curly apostrophe from a straight one', () => {
    expect(texts(pageOf('don’t'), "don't")).toEqual(['don’t'])
  })

  it('matches curly double quotes', () => {
    expect(texts(pageOf('“quoted”'), '"quoted"')).toEqual(['“quoted”'])
  })

  it('matches an en or em dash from a hyphen', () => {
    expect(texts(pageOf('one–two'), 'one-two')).toEqual(['one–two'])
    expect(texts(pageOf('one—two'), 'one-two')).toEqual(['one—two'])
  })

  it('matches a non-breaking space from an ordinary one', () => {
    expect(texts(pageOf('two words'), 'two words')).toEqual(['two words'])
  })
})

describe('whole word', () => {
  it('is off by default, so a substring matches', () => {
    expect(texts(pageOf('a cathedral'), 'cat')).toEqual(['cat'])
  })

  it('excludes a substring when asked', () => {
    expect(findInPage(pageOf('a cathedral'), 'cat', { wholeWord: true })).toEqual([])
  })

  it('still finds the standalone word', () => {
    expect(texts(pageOf('a cat sat'), 'cat', { wholeWord: true })).toEqual(['cat'])
  })

  it('treats punctuation as a boundary', () => {
    expect(texts(pageOf('the cat, and'), 'cat', { wholeWord: true })).toEqual(['cat'])
  })

  it('matches at the very start and end of a line', () => {
    expect(texts(pageOf('cat'), 'cat', { wholeWord: true })).toEqual(['cat'])
  })
})

describe('edge cases', () => {
  // Advancing past the match's start rather than its end is what makes the
  // overlapping occurrences here findable.
  it('finds overlapping occurrences', () => {
    expect(findInPage(pageOf('aaa'), 'aa')).toHaveLength(2)
  })

  it('matches a whole line', () => {
    expect(texts(pageOf('exact'), 'exact')).toEqual(['exact'])
  })

  it('handles a page with no lines', () => {
    expect(findInPage({ lines: [] }, 'anything')).toEqual([])
  })

  /**
   * A phrase broken across a line break is missed, because a line is the
   * unit that has geometry and a cross-line match has no single set of
   * quads to highlight. Every PDF reader has this limitation; pinning it
   * makes it a known one rather than a surprise.
   */
  it('does not match across a line break, and that is deliberate', () => {
    expect(findInPage(pageOf('hello', 'world'), 'hello world')).toEqual([])
  })
})
