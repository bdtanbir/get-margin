import { describe, it, expect } from 'vitest'
import type { Color } from '@margin/pdf-core'
import { detectPaper, applyTint, reachable, isNeutral, WHITE } from '@/features/pages/paperColor'

/** A w x h bitmap filled with one RGBA colour, optionally with one corner off. */
function bitmap(
  w: number,
  h: number,
  rgba: [number, number, number, number],
  corner?: [number, number, number, number],
) {
  const buf = new Uint8Array(w * h * 4)
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = rgba[0]; buf[i + 1] = rgba[1]; buf[i + 2] = rgba[2]; buf[i + 3] = rgba[3]
  }
  if (corner) {
    // The inset the detector samples, in the top-left.
    const i = (1 * w + 1) * 4
    buf[i] = corner[0]; buf[i + 1] = corner[1]; buf[i + 2] = corner[2]; buf[i + 3] = corner[3]
  }
  return { width: w, height: h, rgba: buf }
}

describe('detectPaper', () => {
  it('reads a uniformly painted page', () => {
    const paper = detectPaper(bitmap(20, 20, [255, 0, 0, 255]))
    expect(paper[0]).toBeCloseTo(1)
    expect(paper[1]).toBeCloseTo(0)
    expect(paper[2]).toBeCloseTo(0)
  })

  /**
   * The renderer produces alpha, so a page that paints nothing comes back
   * transparent -- and every viewer, ours included, shows white paper there.
   * Compositing over white is what makes "unpainted" and "painted white" the
   * same answer, which is what the reader sees.
   */
  it('treats an unpainted page as white', () => {
    expect(detectPaper(bitmap(20, 20, [0, 0, 0, 0]))).toEqual(WHITE)
  })

  it('composites a partly transparent paint over white', () => {
    // Half-opaque black over white is mid grey.
    const paper = detectPaper(bitmap(20, 20, [0, 0, 0, 128]))
    expect(paper[0]).toBeCloseTo(0.498, 2)
  })

  /**
   * A full-bleed photograph or a coloured header band has no single paper
   * colour, and reporting whichever corner was sampled first would make the
   * swatch describe a picture rather than the page.
   */
  it('falls back to white when the corners disagree', () => {
    expect(detectPaper(bitmap(20, 20, [255, 0, 0, 255], [0, 0, 255, 255]))).toEqual(WHITE)
  })

  it('falls back to white for a page that has not rendered yet', () => {
    expect(detectPaper(undefined)).toEqual(WHITE)
  })
})

describe('applyTint', () => {
  /**
   * The ordinary case: on a white page the tint IS the colour that comes out,
   * which is why a background reads as "set the page to this colour".
   */
  it('is the colour itself on a white page', () => {
    expect(applyTint(WHITE, [0.2, 0.4, 0.6])).toEqual([0.2, 0.4, 0.6])
  })

  /**
   * THE PROPERTY THAT MAKES A PLAIN MULTIPLY THE RIGHT OPERATION. It can
   * never introduce a channel the page did not already have, so two regions
   * of a page with different papers -- a document that renders its margin
   * orange and its card white -- both move toward the tint instead of each
   * acquiring its own colour cast. Dividing the sampled paper out did not
   * have this property: it turned that white card magenta.
   */
  it('never raises a channel', () => {
    const orange: Color = [235 / 255, 115 / 255, 0]
    const red: Color = [1, 0, 0]
    for (const paper of [orange, WHITE] as Color[]) {
      applyTint(paper, red).forEach((n, i) => {
        expect(n).toBeLessThanOrEqual(paper[i]! + 1e-9)
        expect(n).toBeLessThanOrEqual(red[i]! + 1e-9)
      })
    }
    // Both papers land on red rather than one of them going magenta.
    expect(applyTint(WHITE, red)).toEqual(red)
    expect(applyTint(orange, red)[2]).toBe(0)
  })
})

describe('reachable', () => {
  it('accepts anything on a white page', () => {
    expect(reachable([0.2, 0.9, 0.4], WHITE)).toBe(true)
  })

  it('accepts a colour darker than the paper in every channel', () => {
    expect(reachable([0.5, 0, 0], [1, 0, 0])).toBe(true)
  })

  /** No tint turns a red sheet blue: multiply cannot raise a channel. */
  it('rejects a colour the paper has no channel for', () => {
    expect(reachable([0, 0, 1], [1, 0, 0])).toBe(false)
  })

  /**
   * Judged on the result rather than on a per-channel fit. This page's margin
   * renders at 235, so a pick of pure red does not strictly fit -- and comes
   * out a red nobody could tell from the one they asked for. Warning about
   * that would be noise on every slightly-off-white document there is.
   */
  it('ignores a miss too small to see', () => {
    expect(reachable([1, 0, 0], [235 / 255, 115 / 255, 0])).toBe(true)
  })
})

describe('isNeutral', () => {
  it('recognises the factor that changes nothing', () => {
    expect(isNeutral(WHITE)).toBe(true)
    expect(isNeutral([1, 1, 0.99])).toBe(false)
  })
})
