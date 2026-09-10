import * as mupdf from 'mupdf'
import type { ObjectWriter } from '../index.js'
import type { ImageObject } from '../types.js'
import { appendContent, addResource, alphaState } from '../content.js'
import { contentRectToPage, pagePointToContent, pageBasis, num } from '../coords.js'

export const writeImage: ObjectWriter = (ctx, object) => {
  const o = object as ImageObject
  // The box in PAGE space, because the picture is upright with respect to
  // the page as the user sees it, not with respect to raw user space -- and
  // a quarter turn swaps the two. See `pageBasis`.
  const g = ctx.geometry
  const box = contentRectToPage(o.rect, g)
  const { right, up } = pageBasis(g)
  // Memoised on the bytes, so N copies of one image embed once. A page of
  // repeated stamps or a signature applied on every page would otherwise
  // carry a full copy of the payload per placement.
  const { name, obj } = ctx.xobject(o.data, () => ctx.raw.addImage(new mupdf.Image(o.data)))
  addResource(ctx.raw, ctx.page, 'XObject', name, obj)

  const ops: string[] = []
  if (o.opacity < 1) ops.push(alphaState(ctx.raw, ctx.page, `gs${o.id}`, o.opacity))
  /**
   * An image XObject's own space is the UNIT SQUARE with its origin at the
   * bottom-left, so the CTM carries position, size AND orientation. Its
   * columns are the page's own right and up in content space, which on an
   * unrotated page is the plain `w 0 0 h x y` this replaced. No y-flip: the
   * unit square is already y-up like the surrounding content stream.
   *
   * The anchor is the box's bottom-left ON SCREEN, which in top-down page
   * space is the corner at (x, y + h).
   */
  const anchor = pagePointToContent({ x: box.x, y: box.y + box.h }, g)
  ops.push(
    `${num(box.w * right.x)} ${num(box.w * right.y)} ` +
      `${num(box.h * up.x)} ${num(box.h * up.y)} ` +
      `${num(anchor.x)} ${num(anchor.y)} cm`,
    `/${name} Do`,
  )
  appendContent(ctx.raw, ctx.page, ops.join('\n'))
}
