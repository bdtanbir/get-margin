import { describe, it, expect } from 'vitest'
import type { Color } from '@margin/pdf-core'
import {
  detectPaper, multiplyFactor, applyFactor, reachable, isNeutral, WHITE,
} from '@/features/pages/paperColor'

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

describe('multiplyFactor', () => {
  /**
   * The ordinary case, and the one that must not change: on a white page the
   * factor IS the colour, so everything that worked before this existed keeps
   * working byte for byte.
   */
  it('is the colour itself on a white page', () => {
    expect(multiplyFactor([0.2, 0.4, 0.6], WHITE)).toEqual([0.2, 0.4, 0.6])
  })

  /**
   * THE BUG THIS FIXES. Picking dark red on a page already red used to store
   * dark red and land on red x dark red -- a dirty overlay rather than the
   * colour pointed at.
   */
  it('divides the existing paper back out so the pick lands where it was aimed', () => {
    const paper: Color = [1, 0, 0]
    const target: Color = [0.5, 0, 0]
    expect(applyFactor(paper, multiplyFactor(target, paper))).toEqual(target)
  })

  it('leaves a channel the paper has none of alone rather than dividing by zero', () => {
    expect(multiplyFactor([0, 0, 1], [1, 0, 0])).toEqual([0, 1, 1])
  })

  it('never asks for more than the paper has', () => {
    expect(multiplyFactor([1, 1, 1], [0.5, 0.5, 0.5])).toEqual([1, 1, 1])
  })
})

describe('reachable', () => {
  it('accepts anything on a white page', () => {
    expect(reachable([0.2, 0.9, 0.4], WHITE)).toBe(true)
  })

  it('accepts a colour darker than the paper in every channel', () => {
    expect(reachable([0.5, 0, 0], [1, 0, 0])).toBe(true)
  })

  /** No factor turns a red sheet blue: multiply cannot raise a channel. */
  it('rejects a colour the paper has no channel for', () => {
    expect(reachable([0, 0, 1], [1, 0, 0])).toBe(false)
  })
})

describe('isNeutral', () => {
  it('recognises the factor that changes nothing', () => {
    expect(isNeutral(WHITE)).toBe(true)
    expect(isNeutral([1, 1, 0.99])).toBe(false)
  })
})
