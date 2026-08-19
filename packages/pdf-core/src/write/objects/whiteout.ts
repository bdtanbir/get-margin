import type { ObjectWriter } from '../index.js'
import type { WhiteoutObject } from '../types.js'
import { appendContent, fillColor, alphaState } from '../content.js'
import { toContentSpace, num } from '../coords.js'

/**
 * An opaque rect drawn ABOVE existing content.
 *
 * This covers; it does not remove. The text underneath is still in the
 * content stream and still extractable -- see the "does NOT remove"
 * assertion in whiteout.test.ts, which is a specification, not an
 * oversight. Genuine removal is Phase 6's applyRedactions() path.
 */
export const writeWhiteout: ObjectWriter = (ctx, object) => {
  const o = object as WhiteoutObject
  const { x, y, w, h } = toContentSpace(o.rect)
  const ops: string[] = []
  if (o.opacity < 1) ops.push(alphaState(ctx.raw, ctx.page, `gs${o.id}`, o.opacity))
  ops.push(fillColor(o.fill), `${num(x)} ${num(y)} ${num(w)} ${num(h)} re f`)
  appendContent(ctx.raw, ctx.page, ops.join('\n'))
}
