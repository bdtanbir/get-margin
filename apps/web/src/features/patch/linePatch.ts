import { nanoid } from 'nanoid'
import { hashText, weightOf } from '@margin/pdf-core'
import { fitStyle } from '@/lib/fonts'
import { familyForLine } from '@/lib/fontMatch'
import type { Color, EditObject, LineRun, PatchSpan, TextPatchObject } from '@margin/pdf-core'
import type { BackgroundSample } from './sampleBackground'

/**
 * Shared ground between the two things that can patch a line: the inline
 * editor, where the user retypes it, and the selection toolbar, where they
 * press Bold over it.
 *
 * It exists because those two must agree about three things, and a second
 * implementation of any of them would drift: which patch already covers a
 * line, what "the style the document sets this line in" means, and how a
 * patch is built from a line. The one that would drift silently is the
 * third -- a patch built without a baseline or with `fontSize: 0` looks
 * fine until it is previewed or opened in the inspector.
 */

/**
 * A colour as a PLAIN array, detached from whatever it was read out of.
 *
 * Load-bearing, and the reason is two layers away from here. The quad index
 * arrives from the worker and is parked in a plain `ref()` -- by
 * `PageOverlay` for the inline editor, by the selection store for the
 * toolbar -- and a `ref` holding an object makes that object DEEPLY
 * reactive, so `line.color` is a Proxy over an array rather than an array.
 *
 * Store that Proxy on a patch and it lives in the edit document until
 * Download, which hands the document to the worker by `postMessage`. A
 * Proxy cannot be structure-cloned, so the export fails with "Proxy object
 * could not be cloned" -- pointing at the boundary rather than at the line
 * that put a reactive value into the format three actions earlier.
 *
 * Copying here rather than at the boundary because the format's rule is
 * that an edit document holds plain data, and the place to keep that true
 * is where data enters it.
 */
export function plainColor(c: Color): Color {
  return [c[0], c[1], c[2]]
}

/**
 * A rect as PLAIN numbers, detached from whatever it was read out of.
 *
 * The same hazard `plainColor` exists for, one layer up. A `ref()` holding
 * an object makes that object DEEPLY reactive, so reading a box back out
 * of one hands back a Proxy rather than the literal that was assigned.
 *
 * `LiftTool` keeps the box it is drawing in exactly such a ref, and that
 * Proxy went two places: to `regionCrop`, which is a comlink call and so a
 * `postMessage`, and onto the lifted object as its `rect`. The first threw
 * "Proxy object could not be cloned" the instant the drag ended, which is
 * what the user saw; the second would have failed the export later, far
 * from the code that caused it.
 *
 * Copied here rather than at either boundary because the rule is that an
 * edit document -- and anything handed to the worker -- holds plain data,
 * and the place to keep that true is where the data enters.
 */
export function plainRect(r: { x: number; y: number; w: number; h: number }): {
  x: number; y: number; w: number; h: number
} {
  return { x: r.x, y: r.y, w: r.w, h: r.h }
}

/** The four axes a patch inherits from the line it replaces. */
export type PatchStyle = {
  /** CSS weight, 100 to 800. See `LineRun.weight`. */
  weight: number
  italic: boolean
  fontSize: number
  color: Color
}

/**
 * The style the DOCUMENT itself sets a line in, snapped to the faces of
 * `family` -- the family the patch will be drawn in, which defaults to the
 * one the line resolves to.
 */
export function documentStyle(line: LineRun, family: string = familyForLine(line.font)): PatchStyle {
  // Snapped to what the family has: a Medium heading in a face we carry
  // only at 400 and 700 is drawn at the nearest, not refused.
  const face = fitStyle(family, { weight: line.weight, italic: line.italic })
  return {
    weight: face.weight ?? line.weight,
    italic: face.italic ?? line.italic,
    fontSize: line.size,
    color: plainColor(line.color),
  }
}

/**
 * The style a patch is drawn in.
 *
 * `weight` and `italic` are optional in the format -- absent means 400 and
 * upright, which is what every patch written before they existed meant --
 * so they are normalised here rather than at each comparison.
 */
export function styleOf(patch: TextPatchObject): PatchStyle {
  return {
    weight: weightOf(patch),
    italic: patch.italic === true,
    fontSize: patch.fontSize,
    color: plainColor(patch.color),
  }
}

export function sameStyle(a: PatchStyle, b: PatchStyle): boolean {
  return (
    a.weight === b.weight &&
    a.italic === b.italic &&
    a.fontSize === b.fontSize &&
    a.color.every((channel, i) => channel === b.color[i])
  )
}

/**
 * The line's box in MuPDF page space, from its character quads.
 *
 * Taken from the CHARS rather than the run's stored bbox so it matches
 * exactly what the writer re-derives at export -- the two must agree or the
 * cover lands somewhere the user did not see it.
 */
export function lineBox(line: LineRun): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const c of line.chars) {
    for (let i = 0; i < 8; i += 2) {
      x0 = Math.min(x0, c.quad[i]!); x1 = Math.max(x1, c.quad[i]!)
      y0 = Math.min(y0, c.quad[i + 1]!); y1 = Math.max(y1, c.quad[i + 1]!)
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * The patch already covering a line, if there is one.
 *
 * ONE PATCH PER LINE is load-bearing, not a convention: a patch covers and
 * redraws its whole line, so two on the same line would each cover the
 * other and whichever drew second would win -- silently discarding the
 * first edit, on screen and in the export.
 */
export function patchOnLine(
  objects: Iterable<EditObject>,
  pageId: string,
  lineIndex: number,
): TextPatchObject | undefined {
  for (const o of objects) {
    if (o.kind === 'textPatch' && o.pageId === pageId && o.lineIndex === lineIndex) return o
  }
  return undefined
}

/** Whether a patch has been dragged away from the line it replaces. */
export function isMoved(patch: TextPatchObject): boolean {
  return (patch.offset?.dx ?? 0) !== 0 || (patch.offset?.dy ?? 0) !== 0
}

/**
 * Whether a patch draws exactly what the document already draws.
 *
 * Such a patch is worth deleting rather than keeping: it paints a flat
 * rectangle over the line and redraws it identically, which achieves
 * nothing visible and leaves a scar wherever the background was not flat.
 *
 * THE POSITION COUNTS, not just the words and the style. A pure move
 * changes neither of those, so a check that read only them called a dragged
 * line a no-op -- and `SelectionToolbar` deletes what this calls pristine.
 * Pressing Bold on and off again over a line the user had moved would have
 * put it silently back.
 */
export function isPristine(patch: TextPatchObject, line: LineRun): boolean {
  return (
    patch.text === line.text &&
    !isMoved(patch) &&
    sameStyle(styleOf(patch), documentStyle(line)) &&
    sameSpans(patch.spans, documentSpans(line, patch.fontFamily))
  )
}

/** The style axes a span can override. */
export type SpanAxis = 'weight' | 'italic' | 'scale' | 'rise' | 'color'
const AXES: readonly SpanAxis[] = ['weight', 'italic', 'scale', 'rise', 'color']

const sameColor = (a: Color | undefined, b: Color | undefined): boolean =>
  a === b || (!!a && !!b && a.every((v, i) => v === b[i]))

const sameOverrides = (a: PatchSpan, b: PatchSpan): boolean =>
  a.weight === b.weight && a.italic === b.italic && a.scale === b.scale &&
  a.rise === b.rise && sameColor(a.color, b.color)

const overridesAnything = (s: PatchSpan): boolean => AXES.some((k) => s[k] !== undefined)

/**
 * A span list in its one canonical form: empty pieces dropped, neighbours
 * with the same overrides merged, and UNDEFINED when nothing is
 * overridden -- a list that overrides nothing draws exactly what no list
 * draws, and storing it would make two equal patches compare unequal.
 */
export function normalizeSpans(spans: readonly PatchSpan[] | undefined): PatchSpan[] | undefined {
  if (!spans) return undefined
  const out: PatchSpan[] = []
  for (const span of spans) {
    if (span.text === '') continue
    const last = out[out.length - 1]
    if (last && sameOverrides(last, span)) {
      out[out.length - 1] = { ...last, text: last.text + span.text }
    } else {
      out.push({ ...span, ...(span.color ? { color: plainColor(span.color) } : {}) })
    }
  }
  return out.some(overridesAnything) ? out : undefined
}

export function sameSpans(a: readonly PatchSpan[] | undefined, b: readonly PatchSpan[] | undefined): boolean {
  const x = normalizeSpans(a)
  const y = normalizeSpans(b)
  if (!x || !y) return !x && !y
  return x.length === y.length &&
    x.every((s, i) => s.text === y[i]!.text && sameOverrides(s, y[i]!))
}

/**
 * Drop overrides for `axes` from every span: what a WHOLE-LINE change
 * means. Pressing Bold over a line, or picking a weight in the inspector,
 * makes every word that weight -- including the one that was bold.
 */
export function stripAxes(
  spans: readonly PatchSpan[] | undefined,
  axes: readonly SpanAxis[],
): PatchSpan[] | undefined {
  if (!spans) return undefined
  return normalizeSpans(spans.map((s) => {
    const copy: PatchSpan = { ...s }
    for (const k of axes) delete copy[k]
    return copy
  }))
}

/** Rounded so a 8.0399999 / 12 ratio stores as a number a person can read. */
const ratio = (v: number): number => Math.round(v * 1000) / 1000

/**
 * The line's own styled pieces as span overrides relative to `base`, with
 * each piece's weight snapped to what `family` has -- or undefined for a
 * line that is one style throughout.
 */
export function spansOf(line: LineRun, family: string, base: PatchStyle): PatchSpan[] | undefined {
  const pieces = line.spans
  if (!pieces || pieces.length === 0 || pieces.map((p) => p.text).join('') !== line.text) {
    return undefined
  }
  return normalizeSpans(pieces.map((p) => {
    const face = fitStyle(family, { weight: p.weight, italic: p.italic })
    const weight = face.weight ?? p.weight
    const italic = face.italic ?? p.italic
    const span: PatchSpan = { text: p.text }
    if (weight !== base.weight) span.weight = weight
    if (italic !== base.italic) span.italic = italic
    if (base.fontSize > 0) {
      const scale = ratio(p.size / base.fontSize)
      if (scale !== 1) span.scale = scale
      const rise = ratio(p.rise / base.fontSize)
      if (rise !== 0) span.rise = rise
    }
    if (!sameColor(plainColor(p.color), base.color)) span.color = plainColor(p.color)
    return span
  }))
}

/** The pieces the DOCUMENT sets a line in, relative to its own first piece. */
export function documentSpans(line: LineRun, family: string): PatchSpan[] | undefined {
  return spansOf(line, family, documentStyle(line, family))
}

/** Everything a new patch needs that is not derivable from the line. */
export type NewLinePatch = {
  pageId: string
  lineIndex: number
  line: LineRun
  fontFamily: string
  style: PatchStyle
  /** What is behind the line, sampled from the page as rendered. */
  background: BackgroundSample | undefined
  z: number
  text?: string
  fit?: TextPatchObject['fit']
  /**
   * The styled pieces. Left out, a patch over an UNCHANGED line inherits
   * the line's own pieces -- so moving a line, or restyling one axis of
   * it, keeps its bold words bold -- minus any axis `style` sets
   * differently from the document, which is a whole-line change.
   */
  spans?: PatchSpan[]
}

/**
 * A patch that replaces one line, inheriting everything it does not need to
 * be told.
 *
 * `originalHash` is taken from the line as it is RIGHT NOW, which is what
 * makes the export's guard meaningful rather than circular: the writer
 * re-extracts at export and refuses if the text at this position is no
 * longer what was edited.
 */
export function buildLinePatch(args: NewLinePatch): TextPatchObject {
  const box = lineBox(args.line)
  const text = args.text ?? args.line.text
  let spans = args.spans
  if (spans === undefined && text === args.line.text) {
    const doc = documentStyle(args.line, args.fontFamily)
    const changed: SpanAxis[] = []
    if (doc.weight !== args.style.weight) changed.push('weight')
    if (doc.italic !== args.style.italic) changed.push('italic')
    if (!sameColor(doc.color, args.style.color)) changed.push('color')
    spans = stripAxes(spansOf(args.line, args.fontFamily, doc), changed)
  }
  spans = normalizeSpans(spans)
  return {
    ...(spans ? { spans } : {}),
    id: nanoid(10),
    pageId: args.pageId,
    kind: 'textPatch',
    lineIndex: args.lineIndex,
    originalHash: hashText(args.line.text),
    originalText: args.line.text,
    text,
    fontFamily: args.fontFamily,
    weight: args.style.weight,
    italic: args.style.italic,
    fontSize: args.style.fontSize,
    // The pen position on the line being replaced, so the overlay draws the
    // replacement where the export will put it. Not derivable from the box:
    // how far a baseline sits above it depends on the font's descender.
    baseline: args.line.baseline,
    color: plainColor(args.style.color),
    background: args.background ? plainColor(args.background.color) : [1, 1, 1],
    backgroundConfidence: args.background?.confidence ?? 0,
    fit: args.fit ?? 'overflow',
    rect: box,
    rotation: 0,
    z: args.z,
    locked: false,
    opacity: 1,
  }
}
