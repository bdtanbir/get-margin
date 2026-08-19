import * as mupdf from 'mupdf'
import type { ObjectWriter } from '../index.js'
import type { ImageObject } from '../types.js'
import { appendContent, addResource, alphaState } from '../content.js'
import { toContentSpace, num } from '../coords.js'

export const writeImage: ObjectWriter = (ctx, object) => {
  const o = object as ImageObject
  const { x, y, w, h } = toContentSpace(o.rect)
  // Memoised on the bytes, so N copies of one image embed once. A page of
  // repeated stamps or a signature applied on every page would otherwise
  // carry a full copy of the payload per placement.
  const { name, obj } = ctx.xobject(o.data, () => ctx.raw.addImage(new mupdf.Image(o.data)))
  addResource(ctx.raw, ctx.page, 'XObject', name, obj)

  const ops: string[] = []
  if (o.opacity < 1) ops.push(alphaState(ctx.raw, ctx.page, `gs${o.id}`, o.opacity))
  // An image XObject's own space is the UNIT SQUARE with its origin at the
  // bottom-left, so the CTM carries both position and size: [w 0 0 h x y].
  // No y-flip: the unit square is already y-up like the surrounding content
  // stream (Convention B).
  ops.push(`${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm`, `/${name} Do`)
  appendContent(ctx.raw, ctx.page, ops.join('\n'))
}
