import { nanoid } from 'nanoid'
import { hashText } from '@margin/pdf-core'
import type { Color, EditObject, LineRun, TextPatchObject } from '@margin/pdf-core'
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

/** The four axes a patch inherits from the line it replaces. */
export type PatchStyle = {
  bold: boolean
  italic: boolean
  fontSize: number
  color: Color
}

/** The style the DOCUMENT itself sets a line in. */
export function documentStyle(line: LineRun): PatchStyle {
  return {
    bold: line.bold,
    italic: line.italic,
    fontSize: line.size,
    color: plainColor(line.color),
  }
}

/**
 * The style a patch is drawn in.
 *
 * `bold` and `italic` are optional in the format -- absent means off, which
 * is what every patch written before they existed meant -- so they are
 * normalised here rather than at each comparison.
 */
export function styleOf(patch: TextPatchObject): PatchStyle {
  return {
    bold: patch.bold === true,
    italic: patch.italic === true,
    fontSize: patch.fontSize,
    color: plainColor(patch.color),
  }
}

export function sameStyle(a: PatchStyle, b: PatchStyle): boolean {
  return (
    a.bold === b.bold &&
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
    sameStyle(styleOf(patch), documentStyle(line))
  )
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
  return {
    id: nanoid(10),
    pageId: args.pageId,
    kind: 'textPatch',
    lineIndex: args.lineIndex,
    originalHash: hashText(args.line.text),
    originalText: args.line.text,
    text: args.text ?? args.line.text,
    fontFamily: args.fontFamily,
    bold: args.style.bold,
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
