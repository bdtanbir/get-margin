import * as mupdf from 'mupdf'
import type { ObjectWriter } from '../index.js'
import type { TextPatchObject } from '../types.js'
import { appendContent, addResource, fillColor } from '../content.js'
import { num } from '../coords.js'
import { pdfString } from '../fonts.js'
import { ASCENT_RATIO } from './text.js'

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
  const lines: Array<{ text: string; bbox: [number, number, number, number] }> = []
  structured.walk({
    beginLine: () => { lines.push({ text: '', bbox: [Infinity, Infinity, -Infinity, -Infinity] }) },
    onChar: (c: string, _origin: unknown, _font: unknown, _size: number, quad: number[]) => {
      const line = lines[lines.length - 1]
      if (!line) return
      line.text += c
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
  if (hashText(line.text) !== o.originalHash) {
    throw new PatchRefused(
      `the text at line ${o.lineIndex + 1} has changed since it was edited, so the edit ` +
      `was not applied. It said "${o.originalText}" and now reads "${line.text}".`,
    )
  }

  // The line's box is MuPDF page space (top-down); content-stream drawing
  // is raw user space (bottom-up). Every other writer converts a stored
  // rect; here the geometry comes from extraction, so the flip happens
  // against the page's own height.
  const geometry = ctx.geometry
  const [cx0, cy0, cx1, cy1] = geometry.cropBox
  const pageHeight = Math.abs(cy1 - cy0)
  const [lx0, ly0, lx1, ly1] = line.bbox
  const x = lx0 + cx0
  const y = pageHeight - ly1 + cy0
  const w = lx1 - lx0
  const h = ly1 - ly0

  const font = ctx.fonts.resolve(o.fontFamily)
  addResource(ctx.raw, ctx.page, 'Font', font.name, font.obj)

  // A little bleed, because glyph quads sit tight against the ink and
  // antialiased edges extend past them -- covering exactly the bbox leaves
  // a faint outline of the old text.
  const bleed = Math.max(1, h * 0.12)

  const ops: string[] = [
    fillColor(o.background),
    `${num(x - bleed)} ${num(y - bleed)} ${num(w + bleed * 2)} ${num(h + bleed * 2)} re`,
    'f',
  ]

  if (o.text !== '') {
    let size = o.fontSize > 0 ? o.fontSize : h * 0.8
    let text = o.text
    const advance = () => ctx.measure(text, o.fontFamily, size)

    if (o.fit === 'shrink') {
      // Only ever shrink: growing text to fill a box is not what was asked
      // for and would look like a different edit.
      while (size > 4 && advance() > w) size -= 0.5
    } else if (o.fit === 'truncate') {
      while (text.length > 1 && advance() > w) text = text.slice(0, -1)
    }
    // 'overflow' does nothing on purpose: the user chose to let it run
    // past, and surrounding content is never pushed around (§2.4).

    ops.push(
      fillColor(o.color),
      'BT',
      `/${font.name} ${num(size)} Tf`,
      `1 0 0 1 ${num(x)} ${num(y + h - size * ASCENT_RATIO)} Tm`,
      `${pdfString(text)} Tj`,
      'ET',
    )
  }

  appendContent(ctx.raw, ctx.page, ops.join('\n'))
}
