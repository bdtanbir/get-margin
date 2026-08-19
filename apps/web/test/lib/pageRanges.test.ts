import { describe, it, expect } from 'vitest'
import { parseRanges, partName } from '@/lib/pageRanges'

describe('parseRanges', () => {
  it('parses a single page', () => expect(parseRanges('3', 10)).toEqual([[2]]))
  it('parses a range', () => expect(parseRanges('2-4', 10)).toEqual([[1, 2, 3]]))

  // Each group becomes its own output file.
  it('parses several groups', () => {
    expect(parseRanges('1-2, 5', 10)).toEqual([[0, 1], [4]])
  })

  it('accepts an open-ended range as "to the end"', () => {
    expect(parseRanges('8-', 10)).toEqual([[7, 8, 9]])
  })

  // 1-based in, 0-based out. This boundary is the likeliest bug here.
  it('is 1-based on input and 0-based on output', () => {
    expect(parseRanges('1', 10)).toEqual([[0]])
    expect(parseRanges('10', 10)).toEqual([[9]])
  })

  it('reads a descending range as the range meant, not a reversal', () => {
    expect(parseRanges('4-2', 10)).toEqual([[1, 2, 3]])
  })

  it('clamps past the end instead of inventing pages', () => {
    expect(parseRanges('9-99', 10)).toEqual([[8, 9]])
  })

  it('rejects a range starting past the end, naming the page count', () => {
    expect(() => parseRanges('20', 10)).toThrow(/10 pages/)
  })

  it('rejects page 0', () => expect(() => parseRanges('0', 10)).toThrow(/start at 1/))
  it('rejects nonsense', () => expect(() => parseRanges('abc', 10)).toThrow())
  it('rejects a negative', () => expect(() => parseRanges('-3', 10)).toThrow())
  it('rejects a trailing comma', () => expect(() => parseRanges('1,', 10)).toThrow())

  it('rejects empty input with an actionable message', () => {
    expect(() => parseRanges('   ', 10)).toThrow(/Enter a page range/)
  })

  it('tolerates whitespace around separators', () => {
    expect(parseRanges(' 1 - 2 ,  4 ', 10)).toEqual([[0, 1], [3]])
  })

  it('handles a one-page document', () => {
    expect(parseRanges('1', 1)).toEqual([[0]])
    expect(() => parseRanges('2', 1)).toThrow()
  })
})

describe('partName', () => {
  it('names a range', () => expect(partName('contract.pdf', [0, 1, 2])).toBe('contract-1-3.pdf'))
  it('names a single page without a range', () => expect(partName('contract.pdf', [4])).toBe('contract-5.pdf'))
  it('strips only a trailing .pdf', () => expect(partName('a.pdf.pdf', [0])).toBe('a.pdf-1.pdf'))
  it('falls back for an empty name', () => expect(partName('.pdf', [0])).toBe('document-1.pdf'))
})
