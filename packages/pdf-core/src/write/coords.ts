import { pdfRectToView, type PageGeometry, type Rect } from '@margin/transform'

/**
 * THE TWO CONVENTIONS. Read this before touching any object writer.
 *
 * Phase 2's write path speaks two different coordinate languages at once,
 * and mixing them produces output that looks correct on an unrotated,
 * origin-zero letter page and is wrong everywhere else. This module is the
 * only place either conversion happens.
 *
 * ---------------------------------------------------------------------
 * CONVENTION A -- annotation setters: PAGE SPACE AT SCALE 1
 * ---------------------------------------------------------------------
 * setRect / setQuadPoints / setLine / getRect are top-down, y=0 at the TOP
 * of the CropBox, with the CropBox origin already normalised to (0,0) and
 * /Rotate already applied. MuPDF's binding flips y transparently on every
 * get and set.
 *
 * This was MEASURED in Phase 0 (docs/findings/02-write-path.md Q2), two
 * independent ways: setRect([72,400,200,460]) read back identically while
 * the raw on-disk /Rect was [71,331,201,393]; and pixel-sampling a render
 * matched the unflipped formula within 1-3px while the naive PDF-spec flip
 * was off by 120-140px.
 *
 * Traps:
 *   - Pass points at SCALE 1, never zoom-scaled view pixels. A zoom-scaled
 *     rect is accepted silently and lands the annotation at a multiple of
 *     the correct offset.
 *   - Do NOT apply a manual bottom-up flip. MuPDF already did it.
 *   - Do NOT re-subtract the CropBox origin yourself; pdfRectToView handles
 *     it and MuPDF has already zeroed it (getBounds() === getBounds('CropBox'),
 *     docs/findings/01-read-path.md Q5).
 *
 * ---------------------------------------------------------------------
 * CONVENTION B -- content-stream operators: RAW PDF USER SPACE
 * ---------------------------------------------------------------------
 * Page content streams are drawn in unrotated PDF user space: origin
 * bottom-left, y-up, CropBox origin NOT normalised. Since every EditObject
 * already stores its rect in exactly that space, the conversion is the
 * identity -- and `toContentSpace` exists anyway, as a named seam, so that
 * writers call a documented conversion instead of silently assuming one.
 *
 * Phase 0 did NOT verify this end-to-end: it confirmed the Font/Text/Device
 * primitives render and measure correctly into a standalone Pixmap, but
 * explicitly noted that "wiring this into an actual page content-stream
 * edit was not tested". test/write/pinning.test.ts is what verifies it, and
 * it runs on every commit. VERIFIED end-to-end by that test in Task 24, on
 * an origin-zero page, a non-zero-CropBox page, and a quarter-turned page.
 */

/** Convention A. Returns a MuPDF Rect: [x0, y0, x1, y1], top-down page space. */
export function toAnnotSpace(rect: Rect, g: PageGeometry): [number, number, number, number] {
  // Scale 1 -- unscaled points, NOT zoom-scaled view pixels.
  const v = pdfRectToView(rect, g, 1)
  return [v.x, v.y, v.x + v.w, v.y + v.h]
}

/** Convention B. Identity by construction — see the module comment. */
export function toContentSpace(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
}

/** Formats a number for a content stream: no exponent notation, 4dp max. */
export function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}
