import type { ObjectWriter } from '../index.js'
import type { LinkObject } from '../types.js'
import { toAnnotSpace } from '../coords.js'

/**
 * A link hotspot via page.createLink -- the fz_link API, NOT
 * createAnnotation('Link'). Phase 0 measured that a Link ANNOTATION rejects
 * setRect()/getRect() with an ordinary catchable Error, and that the
 * low-level getObject().put('Rect', ...) escape hatch succeeds but is
 * functionally inert.
 *
 * fz_link has no /AP: link hotspots are invisible by design, per the PDF
 * spec. The editor draws its own affordance (LinkObject.vue) and that
 * affordance is EDITOR-ONLY -- nothing here writes a visible rectangle,
 * because a real PDF link does not have one.
 *
 * Convention A: createLink's bbox is page space at scale 1. Phase 0
 * round-tripped getURI() but never checked where the hotspot landed, which
 * is what link.test.ts pins.
 *
 * The URI is validated in the browser (lib/linkUrl.ts) at op-creation time,
 * so a `javascript:` URL is unrepresentable rather than caught here.
 */
export const writeLink: ObjectWriter = (ctx, object) => {
  const o = object as LinkObject
  ctx.page.createLink(toAnnotSpace(o.rect, ctx.geometry), o.uri)
}
