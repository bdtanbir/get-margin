import type { ObjectWriter } from '../index.js'
import type { TextObject } from '../types.js'
import { appendContent, addResource, fillColor, alphaState } from '../content.js'
import { contentRectToPage, pagePointToContent, pageBasis, textMatrix, num } from '../coords.js'
import { pdfString, faceKey } from '../fonts.js'

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
  /**
   * LAID OUT IN PAGE SPACE, drawn in content space.
   *
   * Alignment within the box and the stack of successive lines are things
   * the user set while looking at the page, so they only mean anything in
   * the space the user was looking at -- and on a /Rotate 90 page that
   * space has the swapped axes. Laying out here and converting the finished
   * pen position is also what keeps this agreeing with the SVG preview,
   * which lays out in page space by construction.
   *
   * On an unrotated page every line below reduces to the arithmetic this
   * replaced, `pageBasis` to (1,0) and `textMatrix` to `1 0 0 1 x y Tm`.
   */
  const g = ctx.geometry
  const box = contentRectToPage(o.rect, g)
  const { right } = pageBasis(g)
  // The FACE, not the family: each weight and slope is a separate font
  // program with its own advance widths, and the alignment maths below
  // reads them. Passing the object rather than its flags is deliberate --
  // see FaceStyle.
  const face = faceKey(o.fontFamily, o)
  const font = ctx.fonts.resolve(face)
  addResource(ctx.raw, ctx.page, 'Font', font.name, font.obj)

  const lines = o.text.split('\n')
  const ops: string[] = []
  if (o.opacity < 1) ops.push(alphaState(ctx.raw, ctx.page, `gs${o.id}`, o.opacity))
  ops.push(fillColor(o.color), 'BT', `/${font.name} ${num(o.fontSize)} Tf`)

  lines.forEach((line, i) => {
    // Page space is top-down, so successive baselines run DOWN from the top
    // of the box -- the same stack the old bottom-up arithmetic described
    // from the other end.
    const fromTop = o.fontSize * ASCENT_RATIO + i * o.fontSize * LINE_HEIGHT
    const advance = ctx.measure(line, face, o.fontSize)
    const offset =
      o.align === 'center' ? (box.w - advance) / 2 : o.align === 'right' ? box.w - advance : 0
    const pen = pagePointToContent({ x: box.x + offset, y: box.y + fromTop }, g)
    ops.push(textMatrix(right, pen.x, pen.y), `${pdfString(line)} Tj`)
  })

  ops.push('ET')
  appendContent(ctx.raw, ctx.page, ops.join('\n'))
}
