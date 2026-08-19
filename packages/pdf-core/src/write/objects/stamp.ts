import type { ObjectWriter } from '../index.js'
import type { StampObject } from '../types.js'
import { appendContent, prependContent, addResource, fillColor, alphaState } from '../content.js'
import { toContentSpace, num } from '../coords.js'
import { pdfString } from '../fonts.js'
import { ASCENT_RATIO } from './text.js'

/**
 * What a stamp's tokens are resolved against. Supplied per page, because
 * that is the whole point of a stamp: one specification, a different result
 * on every page.
 */
export type StampContext = {
  /** 1-based page number in the EDITED document, which is what a reader counts. */
  pageNumber: number
  pageCount: number
  fileName: string
  /** Already formatted; the writer must not invent a locale or a timezone. */
  date: string
  /** The Bates number for this page, already prefixed, padded, and suffixed. */
  bates: string
}

/**
 * Substitute a stamp template's tokens.
 *
 * ONE resolver for every stamp kind, so a token that works in a footer
 * works in a watermark. Four writers would be four places for `{total}` to
 * mean something slightly different.
 *
 * An unknown token is left alone rather than blanked: a user who typed
 * `{page}` instead of `{n}` should see their mistake on the page, not a
 * silent gap they have to work out from an empty footer.
 */
export function resolveTokens(template: string, ctx: StampContext): string {
  return template.replace(/\{(n|total|filename|date|bates)\}/g, (whole, token: string) => {
    switch (token) {
      case 'n': return String(ctx.pageNumber)
      case 'total': return String(ctx.pageCount)
      case 'filename': return ctx.fileName
      case 'date': return ctx.date
      case 'bates': return ctx.bates
      default: return whole
    }
  })
}

/**
 * The Bates number for one page: prefix, zero-padded counter, suffix.
 *
 * Bates numbering is a legal-discovery convention where the sequence must
 * be unbroken and predictable across a whole production, which is why the
 * start and step are explicit rather than derived from the page index.
 */
export function batesNumber(
  index: number,
  opts: { start: number; step: number; digits: number; prefix: string; suffix: string },
): string {
  const value = opts.start + index * opts.step
  return `${opts.prefix}${String(value).padStart(opts.digits, '0')}${opts.suffix}`
}

/**
 * Draw a stamp: watermark, page number, header, footer, or Bates number.
 *
 * CONTENT STREAM TEXT, not an annotation, and that is the whole design.
 * Phase 2's semantic split keeps ink and markup as native annotations
 * precisely so they stay selectable and removable in other PDF tools --
 * which is right for someone's note on a document and wrong for a
 * watermark. A watermark a reader can click and delete is not a watermark.
 * The difference is intent, not mechanism.
 *
 * Rotation is about the box's own centre, matching every other object's
 * `rotation`, so a 45-degree watermark turns in place rather than swinging
 * off the page.
 */
export const writeStamp: ObjectWriter = (ctx, object) => {
  const o = object as StampObject
  const text = o.text
  // BEFORE the font is resolved. A stamp with nothing to say should not
  // fail an export for want of a font it was never going to draw with --
  // which is what an empty page-range token or a cleared template produces.
  if (text === '') return

  const { x, y, w, h } = toContentSpace(o.rect)
  const font = ctx.fonts.resolve(o.fontFamily)
  addResource(ctx.raw, ctx.page, 'Font', font.name, font.obj)

  const ops: string[] = []
  if (o.opacity < 1) ops.push(alphaState(ctx.raw, ctx.page, `gs${o.id}`, o.opacity))
  ops.push(fillColor(o.color), 'BT', `/${font.name} ${num(o.fontSize)} Tf`)

  const advance = ctx.measure(text, o.fontFamily, o.fontSize)
  const baseline = y + h - o.fontSize * ASCENT_RATIO
  const offset = o.align === 'center' ? (w - advance) / 2 : o.align === 'right' ? w - advance : 0

  if (o.rotation) {
    // Rotate about the box centre. The text matrix carries the rotation
    // rather than a `cm` outside BT/ET, because a text matrix is what the
    // baseline placement below is already expressed in -- mixing the two
    // would make the offset mean something different.
    const rad = (o.rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const cx = x + w / 2
    const cy = y + h / 2
    const px = x + offset
    const py = baseline
    // Rotate (px,py) about (cx,cy).
    const rx = cx + (px - cx) * cos - (py - cy) * sin
    const ry = cy + (px - cx) * sin + (py - cy) * cos
    ops.push(`${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} ${num(rx)} ${num(ry)} Tm`)
  } else {
    ops.push(`1 0 0 1 ${num(x + offset)} ${num(baseline)} Tm`)
  }

  ops.push(`${pdfString(text)} Tj`, 'ET')

  const content = ops.join('\n')
  // Under the page's existing content, or over it. Both are wanted and
  // neither is the obvious default: a header belongs on top, a watermark
  // usually belongs beneath so it does not obscure what it is marking.
  if (o.behind) prependContent(ctx.raw, ctx.page, content)
  else appendContent(ctx.raw, ctx.page, content)
}
