import type { ObjectWriter } from '../index.js'
import type { ShapeObject } from '../types.js'
import { appendContent, fillColor, strokeColor, alphaState } from '../content.js'
import { toContentSpace, num } from '../coords.js'

/** Bezier constant for approximating a quarter circle with a cubic. */
const K = 0.5522847498

const ARROWHEAD_LEN = 12
const ARROWHEAD_HALF_WIDTH = 5

function ellipsePath(x: number, y: number, w: number, h: number): string {
  const rx = w / 2
  const ry = h / 2
  const cx = x + rx
  const cy = y + ry
  const ox = rx * K
  const oy = ry * K
  return [
    `${num(cx - rx)} ${num(cy)} m`,
    `${num(cx - rx)} ${num(cy + oy)} ${num(cx - ox)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c`,
    `${num(cx + ox)} ${num(cy + ry)} ${num(cx + rx)} ${num(cy + oy)} ${num(cx + rx)} ${num(cy)} c`,
    `${num(cx + rx)} ${num(cy - oy)} ${num(cx + ox)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c`,
    `${num(cx - ox)} ${num(cy - ry)} ${num(cx - rx)} ${num(cy - oy)} ${num(cx - rx)} ${num(cy)} c`,
  ].join('\n')
}

/**
 * The arrowhead is computed geometry -- a filled triangle at the line's end,
 * not an annotation feature (spec 2.1). Drawn in the same content stream so
 * it can never separate from its shaft.
 */
function arrowPath(x: number, y: number, w: number, h: number): string {
  const x2 = x + w
  const y2 = y + h
  const len = Math.hypot(w, h) || 1
  const ux = w / len
  const uy = h / len
  const bx = x2 - ux * ARROWHEAD_LEN
  const by = y2 - uy * ARROWHEAD_LEN
  // Perpendicular unit vector.
  const px = -uy * ARROWHEAD_HALF_WIDTH
  const py = ux * ARROWHEAD_HALF_WIDTH
  return [
    `${num(x)} ${num(y)} m ${num(bx)} ${num(by)} l S`,
    `${num(x2)} ${num(y2)} m ${num(bx + px)} ${num(by + py)} l ${num(bx - px)} ${num(by - py)} l h f`,
  ].join('\n')
}

export const writeShape: ObjectWriter = (ctx, object) => {
  const o = object as ShapeObject
  const { x, y, w, h } = toContentSpace(o.rect)
  const ops: string[] = []

  if (o.opacity < 1) ops.push(alphaState(ctx.raw, ctx.page, `gs${o.id}`, o.opacity))
  if (o.fill) ops.push(fillColor(o.fill))
  if (o.stroke) {
    ops.push(strokeColor(o.stroke))
    ops.push(`${num(o.strokeWidth)} w`)
  }

  // Painting operator: fill only, stroke only, or both. A shape with
  // neither draws nothing rather than defaulting to a stroke the user did
  // not ask for.
  const paint = o.fill && o.stroke ? 'B' : o.fill ? 'f' : o.stroke ? 'S' : 'n'

  switch (o.kind) {
    case 'rect':
      ops.push(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re ${paint}`)
      break
    case 'ellipse':
      ops.push(ellipsePath(x, y, w, h), paint)
      break
    case 'line':
      // A line has no interior, so it is stroke-or-nothing regardless of
      // `paint`: `f` on an open two-point path would paint a zero-area
      // region, i.e. nothing, and silently lose a stroked line.
      if (o.stroke) ops.push(`${num(x)} ${num(y)} m ${num(x + w)} ${num(y + h)} l S`)
      break
    case 'arrow':
      // The head is filled with the stroke colour so shaft and head match.
      if (o.stroke) {
        ops.push(fillColor(o.stroke))
        ops.push(arrowPath(x, y, w, h))
      }
      break
  }

  appendContent(ctx.raw, ctx.page, ops.join('\n'))
}
