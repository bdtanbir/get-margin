/**
 * Parse a page-range expression into groups of ZERO-BASED page indices.
 *
 * Input is 1-based because that is what the page numbers on screen say;
 * output is 0-based because that is what `pageOrder` is indexed by. Getting
 * that boundary wrong is the single most likely bug in this feature, so the
 * conversion happens here, once, and nowhere else.
 *
 * Each comma-separated group becomes its OWN output file:
 *   "1-2, 5"  ->  [[0, 1], [4]]  ->  two PDFs
 */
export function parseRanges(input: string, pageCount: number): number[][] {
  const raw = input.trim()
  if (!raw) throw new Error('Enter a page range, for example 1-3, 5.')

  return raw.split(',').map((part) => {
    const text = part.trim()
    if (!text) throw new Error(`"${part}" is not a page range.`)

    const match = /^(\d+)\s*(-)?\s*(\d+)?$/.exec(text)
    if (!match) throw new Error(`"${text}" is not a page range.`)

    const from = Number(match[1])
    // "8-" means "8 to the end", which is what people type for a tail.
    const to = match[2] ? (match[3] ? Number(match[3]) : pageCount) : from

    if (from < 1 || to < 1) throw new Error('Page numbers start at 1.')
    if (from > pageCount) {
      throw new Error(`This document has ${pageCount} pages, so "${text}" is out of range.`)
    }

    // Descending is a typo, not an instruction to reverse the document;
    // read it as the range the user meant.
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    // Clamped rather than rejected: "9-99" on a 10-page document plainly
    // means "to the end".
    const end = Math.min(hi, pageCount)

    const pages: number[] = []
    for (let i = lo; i <= end; i++) pages.push(i - 1)
    return pages
  })
}

/** `contract.pdf` + pages 0..2 -> `contract-1-3.pdf`. */
export function partName(fileName: string, pages: number[]): string {
  const stem = fileName.replace(/\.pdf$/i, '') || 'document'
  const first = (pages[0] ?? 0) + 1
  const last = (pages[pages.length - 1] ?? 0) + 1
  return first === last ? `${stem}-${first}.pdf` : `${stem}-${first}-${last}.pdf`
}
