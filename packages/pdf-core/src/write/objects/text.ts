import type { ObjectWriter } from '../index.js'
import type { TextObject } from '../types.js'
import { appendContent, addResource, fillColor, alphaState } from '../content.js'
import { toContentSpace, num } from '../coords.js'
import { pdfString } from '../fonts.js'

/**
 * Baseline sits this fraction of the font size below the line's top, and
 * successive lines are this multiple of the size apart. Both must stay equal
 * to ASCENT_RATIO / LINE_HEIGHT in apps/web/src/lib/fonts.ts -- the SVG
 * preview lays text out with the same two numbers, and a mismatch is text
 * that shifts the moment you export it.
 */
export const ASCENT_RATIO = 0.8
export const LINE_HEIGHT = 1.2

export const writeText: ObjectWriter = (ctx, object) => {
  const o = object as TextObject
  const { x, y, w, h } = toContentSpace(o.rect)
  const font = ctx.fonts.resolve(o.fontFamily)
  addResource(ctx.raw, ctx.page, 'Font', font.name, font.obj)

  const lines = o.text.split('\n')
  const ops: string[] = []
  if (o.opacity < 1) ops.push(alphaState(ctx.raw, ctx.page, `gs${o.id}`, o.opacity))
  ops.push(fillColor(o.color), 'BT', `/${font.name} ${num(o.fontSize)} Tf`)

  lines.forEach((line, i) => {
    // PDF text origin is the BASELINE, and the box's y is its bottom edge,
    // so lines are laid out downward from the box top.
    const baseline = y + h - o.fontSize * ASCENT_RATIO - i * o.fontSize * LINE_HEIGHT
    const advance = ctx.measure(line, o.fontFamily, o.fontSize)
    const offset = o.align === 'center' ? (w - advance) / 2 : o.align === 'right' ? w - advance : 0
    ops.push(`1 0 0 1 ${num(x + offset)} ${num(baseline)} Tm`, `${pdfString(line)} Tj`)
  })

  ops.push('ET')
  appendContent(ctx.raw, ctx.page, ops.join('\n'))
}
