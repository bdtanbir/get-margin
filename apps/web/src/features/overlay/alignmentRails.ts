import type { PageQuadIndex } from '@margin/pdf-core'

/**
 * The lines a dragged element can be lined up against, in MuPDF page space.
 *
 * DERIVED FROM THE PAGE, not from a fixed lattice. A uniform grid tells you
 * where a notional grid is, which is never where the document's own columns
 * are -- and lining a moved line up with a grid that the surrounding text
 * does not obey looks worse than not lining it up at all. So the rails are
 * the coordinates the page already uses: the left and right edge of every
 * line of text, and every baseline.
 *
 * Baselines rather than glyph-box tops and bottoms. A reader perceives two
 * lines as level when their baselines agree -- the boxes above them differ
 * by whatever the tallest ascender happens to be -- and the baseline is
 * also the number a patch actually stores, so a rail the user hits is a
 * rail the export honours.
 *
 * Pure, and separate from the component that draws them, so the arithmetic
 * can be tested without a DOM.
 */
export type Rails = {
  /** Vertical rails: x coordinates, ascending. */
  xs: number[]
  /** Horizontal rails: y coordinates, ascending. */
  ys: number[]
}

/**
 * How far apart two coordinates may be, in points, and still be one rail.
 *
 * Text that looks flush is rarely flush to the micron: a left margin shared
 * by forty lines arrives as forty numbers a fraction of a point apart, and
 * drawing all of them produces one thick fuzzy band instead of one line.
 * Half a point is under a screen pixel at 100%, so nothing a user could
 * have aimed at separately is merged.
 */
const TOLERANCE = 0.5

export type RailOptions = {
  /**
   * A line index to leave out -- the one being dragged. Its own rails would
   * sit under the moving text and read as a snap target that is only ever
   * "where this line already was".
   */
  exclude?: number
}

/**
 * No cap on how many rails come back, deliberately.
 *
 * The quantum is what keeps the count sane, and it does the work: an
 * ordinary page's forty lines collapse to a handful of columns because
 * documents ARE column-aligned. A page that genuinely uses two hundred
 * distinct x positions is a page where two hundred rails is the truth, and
 * silently showing the first eighty of them would claim a completeness the
 * display does not have.
 */
export function alignmentRails(index: PageQuadIndex, opts: RailOptions = {}): Rails {
  const xs: number[] = []
  const ys: number[] = []

  for (const [i, line] of index.lines.entries()) {
    if (i === opts.exclude) continue
    // An empty line has a degenerate bbox and no baseline worth trusting.
    if (line.chars.length === 0) continue
    xs.push(line.bbox[0])
    xs.push(line.bbox[2])
    ys.push(line.baseline)
  }

  return { xs: cluster(xs), ys: cluster(ys) }
}

/**
 * Near-identical coordinates collapsed to one rail each, ascending.
 *
 * CLUSTERED, not rounded to a grid. Rounding was the obvious
 * implementation and it is wrong in a way a test caught: two values a
 * tenth of a point apart that happen to straddle a bucket boundary --
 * 100.0 and 100.3 against a half-point grid -- round to DIFFERENT buckets
 * and survive as two rails, which is the exact fuzzy double line the
 * merging exists to prevent. Whether two coordinates merge has to depend
 * on the distance between them, not on where they sit relative to a
 * lattice they know nothing about.
 *
 * A cluster is capped at `TOLERANCE` wide, measured from its first member,
 * so a long chain of values half a point apart cannot merge transitively
 * into one rail spanning the page. The representative is the cluster's
 * mean: it is what a reader would call "the margin", and it does not
 * depend on which line the extraction happened to report first.
 */
function cluster(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const rails: number[] = []
  let group: number[] = []

  const flush = (): void => {
    if (group.length === 0) return
    rails.push(group.reduce((sum, v) => sum + v, 0) / group.length)
    group = []
  }

  for (const v of sorted) {
    if (group.length > 0 && v - group[0]! > TOLERANCE) flush()
    group.push(v)
  }
  flush()
  return rails
}
