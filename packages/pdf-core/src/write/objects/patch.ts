import { saneQuad } from '../../text/saneQuad.js'
import * as mupdf from 'mupdf'
import type { ObjectWriter } from '../index.js'
import type { TextPatchObject } from '../types.js'
import { appendContent, addResource, fillColor } from '../content.js'
import {
  num, pageBoxToContent, pagePointToContent, pageDeltaToContent, pageDirToContent, textMatrix,
} from '../coords.js'
import { pdfText, faceKey } from '../fonts.js'
import { patchRuns, runsAdvance, truncateRuns, type PatchRun } from '../patchRuns.js'
import { ASCENT_RATIO } from './text.js'
import { hiddenIndices, invisibleCharTest } from '../../text/invisible.js'

/**
 * A stable hash of a line's original text.
 *
 * FNV-1a: deterministic, dependency-free, and synchronous -- the write path
 * has no async budget and `crypto.subtle` is a promise. Collision
 * resistance is not the property being bought here; this guards against a
 * line having CHANGED, not against an attacker choosing a collision.
 */
export function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export class PatchRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PatchRefused'
  }
}

/**
 * Which characters a font cannot draw.
 *
 * Embedded fonts in real PDFs are almost always SUBSETS containing only the
 * glyphs the document already uses (`PLAN.md` §2.5), so typing "Ø" into a
 * run whose subset lacks it has no glyph to draw. MuPDF returns glyph 0 --
 * the .notdef box -- rather than failing, which is how a patch silently
 * becomes a row of empty rectangles.
 */
export function missingGlyphs(font: mupdf.Font, text: string): string[] {
  const missing: string[] = []
  for (const ch of text) {
    // Whitespace has no glyph in many fonts and needs none.
    if (ch === ' ' || ch === '\t') continue
    if (font.encodeCharacter(ch) === 0 && !missing.includes(ch)) missing.push(ch)
  }
  return missing
}

/**
 * The same check, from font BYTES.
 *
 * Exists so the web app can ask without importing mupdf itself: the
 * engine stays behind pdf-core, and the app ships no second copy of a
 * 10MB wasm module to answer a question about three characters.
 */
export function missingGlyphsFor(
  fontBytes: Uint8Array,
  family: string,
  text: string,
): string[] {
  return missingGlyphs(new mupdf.Font(family, fontBytes), text)
}

/**
 * Replace a line of the document's own text.
 *
 * COVER AND REDRAW, not removal. An opaque rectangle in the sampled
 * background colour, then the new text over it. Removal is redaction's job
 * and has its own primitive; using `applyRedactions` for an ordinary edit
 * would be slower and would destroy more than was asked for.
 *
 * THE HASH GUARD IS THE POINT. A patch is addressed by where a line was
 * when the user edited it -- page, line index -- and extraction is not
 * guaranteed stable across MuPDF versions or option changes. If the line
 * now hashes differently, the text at that position is not the text the
 * user was looking at, so the patch REFUSES rather than covering whatever
 * happens to be there now. `PLAN.md` §2.4: fail loudly, never silently
 * mispatch. Quietly patching the wrong line is the worst outcome available
 * -- it damages a document while reporting success.
 */
export const writeTextPatch: ObjectWriter = (ctx, object) => {
  const o = object as TextPatchObject

  // Re-extract the line as it is NOW, in the assembled export.
  const structured = ctx.page.toStructuredText('')
  const lines: Array<{
    text: string
    bbox: [number, number, number, number]
    /** The size the line was actually set in, from its first glyph. */
    size: number
    /**
     * Where the pen sat at the start of the line, in MuPDF PAGE space
     * (Convention C). The WHOLE point, not just its y: on a turned page the
     * pen does not run along page-space x, so an x reconstructed from the
     * bbox would be the wrong corner of it.
     */
    origin: { x: number; y: number } | null
    /**
     * Which way the line runs, in page space: [1,0] reads left-to-right on
     * screen. MuPDF hands this to `beginLine`; `pageDirToContent` turns it
     * into the direction the run was actually drawn in.
     */
    dir: { x: number; y: number }
    /** Each character and its pen position, to tell which ones draw nothing. */
    glyphs: Array<{ char: string; origin: number[] }>
  }> = []
  structured.walk({
    beginLine: (_bbox: unknown, _wmode: number, direction: number[]) => {
      lines.push({
        text: '',
        bbox: [Infinity, Infinity, -Infinity, -Infinity],
        size: 0,
        origin: null,
        glyphs: [],
        // A walker that predates the argument, or a degenerate run, reads
        // as ordinary left-to-right rather than as a zero-length direction.
        dir: { x: direction?.[0] ?? 1, y: direction?.[1] ?? 0 },
      })
    },
    onChar: (c: string, origin: number[], _font: unknown, size: number, quad: number[]) => {
      const line = lines[lines.length - 1]
      if (!line) return
      // First glyph decides: a line is a homogeneous style run in MuPDF's
      // model, and the pen position at its start is the line's baseline.
      if (line.text === '') {
        line.size = size
        line.origin = { x: origin[0] ?? 0, y: origin[1] ?? 0 }
      }
      line.text += c
      line.glyphs.push({ char: c, origin: [origin[0] ?? 0, origin[1] ?? 0] })
      // Capped exactly as buildQuadIndex caps it, so the cover exported is
      // the cover the user saw. See saneQuad.ts.
      quad = saneQuad(quad, origin, size)
      for (let i = 0; i < 8; i += 2) {
        line.bbox[0] = Math.min(line.bbox[0], quad[i]!)
        line.bbox[2] = Math.max(line.bbox[2], quad[i]!)
        line.bbox[1] = Math.min(line.bbox[1], quad[i + 1]!)
        line.bbox[3] = Math.max(line.bbox[3], quad[i + 1]!)
      }
    },
  } as never)

  const line = lines[o.lineIndex]
  if (!line) {
    throw new PatchRefused(
      `the line this edit refers to is no longer on the page (line ${o.lineIndex + 1})`,
    )
  }
  // The line as the editor showed it: without the U+FFFD characters that
  // draw nothing, by the same rule buildQuadIndex applies (invisible.ts).
  // The raw text is accepted too, for an edit saved before that rule
  // existed -- it hashed the line with them in.
  const hidden = line.text.includes('\ufffd')
    ? hiddenIndices(line.glyphs, invisibleCharTest(ctx.page))
    : new Set<number>()
  const shown = line.glyphs.filter((_, i) => !hidden.has(i)).map((g) => g.char).join('')
  if (hashText(shown) !== o.originalHash && hashText(line.text) !== o.originalHash) {
    throw new PatchRefused(
      `the text at line ${o.lineIndex + 1} has changed since it was edited, so the edit ` +
      `was not applied. It said "${o.originalText}" and now reads "${shown}".`,
    )
  }

  /**
   * The line's box is MuPDF page space (Convention C); content-stream
   * drawing is raw user space (Convention B). Every other writer converts a
   * stored rect, which is already Convention B; here the geometry comes
   * from extraction, so it needs the real conversion.
   *
   * This used to flip y against the UNROTATED CropBox height and pass x
   * through untouched -- correct on a /Rotate 0 page and wrong on every
   * turned one, where page space has the swapped axes. On the /Rotate 90
   * invoice that produced this fix, the cover landed off the page entirely
   * and the replacement was drawn at a right angle to the line it replaced.
   */
  const geometry = ctx.geometry
  const { x, y, w, h } = pageBoxToContent(line.bbox, geometry)

  /**
   * The line's extent ALONG the text and ACROSS it, both measured in page
   * space, where the writing direction is known.
   *
   * `w` and `h` above cannot stand in for these. A quarter-turn swaps them,
   * so on a /Rotate 90 page `w` is the thickness of the glyph band rather
   * than the length of the line -- and `fit` measured against it shrank a
   * replacement to nothing, while a bleed proportional to it grew to cover
   * the whole line. Both come off the page-space box and the reported
   * direction instead, which stay meaningful whichever way the page turns.
   */
  const [bx0, by0, bx1, by1] = line.bbox
  const horizontal = Math.abs(line.dir.x) >= Math.abs(line.dir.y)
  const along = Math.abs(horizontal ? bx1 - bx0 : by1 - by0)
  const across = Math.abs(horizontal ? by1 - by0 : bx1 - bx0)

  /**
   * Where the replacement is drawn, relative to the line it replaces.
   *
   * `offset` is measured in page space, which is top-down and, on a turned
   * page, differently-axed from the content stream -- so it is converted as
   * a DISTANCE rather than added to the pen directly. On an unrotated page
   * this comes out as `+dx, -dy`, the inline flip this replaced;
   * `patch.test.ts` pins the direction because getting it wrong moves the
   * text exactly as far the wrong way, which reads as deliberate.
   */
  const dx = o.offset?.dx ?? 0
  const dy = o.offset?.dy ?? 0
  const moved = dx !== 0 || dy !== 0
  const shift = pageDeltaToContent({ x: dx, y: dy }, geometry)

  /**
   * One face per differently-styled run. A line with a bold name in it
   * needs the regular AND the bold embedded, each registered once however
   * many runs use it.
   */
  const runFace = (run: PatchRun): string =>
    faceKey(o.fontFamily, { weight: run.weight, italic: run.italic })
  const allRuns = patchRuns(o)
  const fontFor = new Map<string, { name: string; font: mupdf.Font }>()
  for (const run of allRuns) {
    const face = runFace(run)
    if (fontFor.has(face)) continue
    const font = ctx.fonts.resolve(face)
    fontFor.set(face, { name: addResource(ctx.raw, ctx.page, 'Font', font.name, font.obj), font: font.font })
  }

  // A little bleed, because glyph quads sit tight against the ink and
  // antialiased edges extend past them -- covering exactly the bbox leaves
  // a faint outline of the old text.
  const bleed = Math.max(1, across * 0.12)

  const ops: string[] = [
    fillColor(o.background),
    `${num(x - bleed)} ${num(y - bleed)} ${num(w + bleed * 2)} ${num(h + bleed * 2)} re`,
    'f',
  ]

  if (o.text !== '') {
    /**
     * The size the line was actually set in, not a fraction of its box.
     *
     * `h * 0.8` was a guess at the relationship between a glyph box and a
     * font size, and it is wrong by however much the font's ascent and
     * descent differ from that ratio -- so a replacement came out a
     * different size from the text around it.
     */
    let size = o.fontSize > 0 ? o.fontSize : line.size > 0 ? line.size : across * 0.8
    let runs = allRuns
    let count = [...o.text].length
    const spacing = o.letterSpacing ?? 0
    // Measured WITH the spacing: the fit rules decide against the ink the
    // line will actually take up, and a spaced line takes up more. Each run
    // in its own face, because a bold word is wider than the same word
    // regular.
    const advance = () =>
      runsAdvance(runs, size, spacing, (run, at) => ctx.measure(run.text, runFace(run), at))

    /**
     * A MOVED patch always overflows, whatever `fit` says.
     *
     * Both fit rules measure against `along`, the length of the line being
     * replaced. Once the text is drawn somewhere else, that width describes
     * a box the text is no longer in -- so shrinking or cutting to it
     * damages the replacement to fit a constraint that has stopped
     * existing, and the user sees characters disappear for no reason
     * visible on the page.
     */
    if (moved) {
      // Nothing: 'overflow' semantics.
    } else if (o.fit === 'shrink') {
      // Only ever shrink: growing text to fill a box is not what was asked
      // for and would look like a different edit.
      while (size > 4 && advance() > along) size -= 0.5
    } else if (o.fit === 'truncate') {
      while (count > 1 && advance() > along) runs = truncateRuns(allRuns, --count)
    }
    // 'overflow' does nothing on purpose: the user chose to let it run
    // past, and surrounding content is never pushed around (§2.4).

    /**
     * Sit on the line's OWN pen position.
     *
     * This used to place the text at `y + h - size * ASCENT_RATIO`, which
     * derives a baseline from the glyph box and a constant. How far a
     * baseline sits above the bottom of its glyph box depends on the
     * font's descender, so the derived position missed the real one --
     * measured by diffing an export against its original, the replacement
     * sat visibly higher than the text it replaced while the surrounding
     * lines stayed put.
     *
     * The extraction knows where the pen actually was, and knows it as a
     * POINT: on a turned page the pen does not run along page-space x, so
     * taking its y alone and pairing that with the box's left edge picks a
     * corner the text never started from. The fallback keeps the old
     * derivation for a run that reported no origin at all.
     */
    const pen = line.origin
      ? pagePointToContent(line.origin, geometry)
      : { x, y: y + h - size * ASCENT_RATIO }
    // The fallback is the pre-extraction guess and is only meaningful on an
    // unrotated page; it is reachable only for a run that reported no
    // glyphs at all, which cannot hash-match a non-empty original.

    /**
     * Drawn along the ORIGINAL run's direction, not along user-space +x.
     *
     * A content stream is turned with its page when it is displayed, so
     * text drawn axis-aligned on a /Rotate 90 page comes out at a right
     * angle to everything around it -- which is exactly what a patched
     * invoice looked like. `pageDirToContent` turns the page-space
     * direction MuPDF reported for this line back into the direction the
     * run was drawn in, so the replacement lies along the text it replaces.
     */
    const u = pageDirToContent(line.dir, geometry)

    /**
     * ONE text object, the runs drawn one after another with `Tj`. Each
     * `Tj` moves the pen by its own glyphs' advances, so a run starts
     * exactly where the previous one ended -- no x is computed here that
     * the viewer could disagree with. Between runs only the state changes:
     * colour, face and size, and `Ts` for a raised or lowered piece. The
     * `q`/`Q` around this stream resets `Ts` and `Tc` afterwards.
     */
    ops.push(
      'BT',
      // See the text writer: points per gap, and only when there are any.
      ...(spacing !== 0 ? [`${num(spacing)} Tc`] : []),
      textMatrix(u, pen.x + shift.x, pen.y + shift.y),
    )
    let rise = 0
    for (const run of runs) {
      const font = fontFor.get(runFace(run))!
      ops.push(fillColor(run.color), `/${font.name} ${num(size * run.scale)} Tf`)
      if (run.rise !== rise) {
        rise = run.rise
        ops.push(`${num(size * rise)} Ts`)
      }
      ops.push(`${pdfText(font.font, run.text)} Tj`)
    }
    ops.push('ET')
  }

  appendContent(ctx.raw, ctx.page, ops.join('\n'))
}
