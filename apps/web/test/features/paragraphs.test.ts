import { describe, it, expect } from 'vitest'
import type { LineRun, PageQuadIndex, Quad } from '@margin/pdf-core'
import { paragraphAt, joinLineTexts } from '@/features/patch/paragraphs'

/** A 12pt line whose characters are 6pt wide, top at `baseline - 9`. */
function line(text: string, x: number, baseline: number, opts: Partial<LineRun> = {}): LineRun {
  const size = opts.size ?? 12
  const w = size / 2
  return {
    bbox: [x, baseline - size * 0.75, x + text.length * w, baseline + size * 0.25],
    text, font: 'Times', weight: 400, italic: false, color: [0, 0, 0],
    size, baseline, block: 0,
    chars: [...text].map((char, i) => ({
      char,
      quad: [x + i * w, baseline - size * 0.75, x + (i + 1) * w, baseline - size * 0.75,
        x + i * w, baseline + size * 0.25, x + (i + 1) * w, baseline + size * 0.25] as Quad,
    })),
    ...opts,
  }
}

const page = (...lines: LineRun[]): PageQuadIndex => ({ lines })

describe('paragraphAt', () => {
  // Three rows 26pt apart (double spacing, as in the reported document),
  // then a new paragraph after a bigger gap.
  const index = page(
    line('Careers in health and social care may follow', 72, 100),
    line('responsibilities and workplace. Each career path', 72, 126),
    line('experience and progression.', 72, 152),
    line('Social Work Assistant: This pathway focuses on', 72, 197),
    line('emotional and practical needs while working with', 72, 223),
  )

  it('finds the whole paragraph from its last line', () => {
    const p = paragraphAt(index, 2)!
    expect(p.lines).toEqual([0, 1, 2])
    expect(p.leading).toBeCloseTo(26 / 12, 3)
    expect(p.indent).toBe(0)
    // As wide as the column, which the next paragraph's lines also reach.
    expect(p.width).toBe(48 * 6 + 1)
  })

  it('does not run into the next paragraph', () => {
    expect(paragraphAt(index, 3)!.lines).toEqual([3, 4])
  })

  it('stops at a short last row even when the spacing is the same', () => {
    const tight = page(
      line('A long first row of the first paragraph here', 72, 100),
      line('short end.', 72, 114),
      line('Next paragraph starts at the same spacing too', 72, 128),
    )
    // Two rows only: the short row cannot be told from a normal one yet.
    expect(paragraphAt(tight, 0)!.lines).toEqual([0, 1])
    const three = page(
      line('A long first row of the first paragraph here', 72, 100),
      line('and a second row that is as long as the first', 72, 114),
      line('short end.', 72, 128),
      line('Next paragraph starts at the same spacing too', 72, 142),
    )
    expect(paragraphAt(three, 0)!.lines).toEqual([0, 1, 2])
    expect(paragraphAt(three, 3)!.lines).toEqual([3])
  })

  it('keeps a heading out of the body below it', () => {
    const p = page(
      line('Heading', 72, 100, { size: 16 }),
      line('Body text under the heading goes on here', 72, 120),
      line('and continues on a second row like this', 72, 134),
    )
    expect(paragraphAt(p, 0)!.lines).toEqual([0])
    expect(paragraphAt(p, 1)!.lines).toEqual([1, 2])
  })

  it('reads a row split into two lines as one row', () => {
    const p = page(
      line('Bold label:', 72, 100, { weight: 700 }),
      line('and the rest of the first row', 72 + 11 * 6 + 3, 100),
      line('second row of the same paragraph is here', 72, 114),
    )
    expect(paragraphAt(p, 2)!.lines).toEqual([0, 1, 2])
  })

  it('keeps table cells on one baseline apart', () => {
    const p = page(
      line('Name:', 72, 100),
      line('Rumi Akther', 200, 100),
      line('Date:', 350, 100),
    )
    expect(paragraphAt(p, 1)!.lines).toEqual([1])
  })

  it('allows an indented first row', () => {
    const p = page(
      line('Indented first row of a paragraph', 90, 100),
      line('second row starts further left than it', 72, 114),
      line('third row starts at the same left edge', 72, 128),
    )
    const para = paragraphAt(p, 1)!
    expect(para.lines).toEqual([0, 1, 2])
    expect(para.indent).toBeCloseTo(18, 5)
  })

  it('never merges across MuPDF blocks that hold several rows', () => {
    const p = page(
      line('First block, first row of it is long', 72, 100, { block: 0 }),
      line('first block, second row is as long', 72, 114, { block: 0 }),
      line('Second block, first row of it is long', 72, 128, { block: 1 }),
      line('second block, second row is as long', 72, 142, { block: 1 }),
    )
    expect(paragraphAt(p, 0)!.lines).toEqual([0, 1])
    expect(paragraphAt(p, 3)!.lines).toEqual([2, 3])
  })

  it('ignores blocks when every line is a block of its own, as Word exports them', () => {
    const p = page(
      line('Each row in its own block, as Word does', 72, 100, { block: 0 }),
      line('and still one paragraph to the reader', 72, 120, { block: 1 }),
      line('end.', 72, 140, { block: 2 }),
      line('Next paragraph after a bigger gap here', 72, 172, { block: 3 }),
      line('with its own second row of text below', 72, 192, { block: 4 }),
    )
    expect(paragraphAt(p, 2)!.lines).toEqual([0, 1, 2])
    expect(paragraphAt(p, 3)!.lines).toEqual([3, 4])
  })

  it('does not join two headings a couple of lines apart', () => {
    const p = page(
      line('Task 1', 72, 100, { size: 16 }),
      line('LO1', 72, 146, { size: 14 }),
    )
    expect(paragraphAt(p, 0)!.lines).toEqual([0])
  })

  it('leaves out rows that already have their own patch', () => {
    expect(paragraphAt(index, 2, (i) => i === 0)!.lines).toEqual([1, 2])
    expect(paragraphAt(index, 0, (i) => i === 1)!.lines).toEqual([0])
  })

  it('does not wrap a lone line with no column to wrap to', () => {
    const p = paragraphAt(page(line('Lonely heading', 300, 100)), 0)!
    expect(p.lines).toEqual([0])
    expect(p.width).toBe(0)
  })

  it('wraps a lone line at the column it starts in', () => {
    const p = page(
      line('Short line', 72, 100),
      line('A much longer line in the same column below it', 72, 300, { block: 1 }),
    )
    expect(paragraphAt(p, 0)!.width).toBeCloseTo(46 * 6 + 1, 5)
  })
})

describe('joinLineTexts', () => {
  it('joins rows with one space and a hyphen straight on', () => {
    expect(joinLineTexts(['the role, ', ' and work-', 'place'])).toBe('the role, and work-place')
  })
})
