import { describe, it, expect } from 'vitest'
import { saneQuad, ASCENT, DESCENT } from '../../src/text/saneQuad.js'

/** An upright glyph at x 10..20, pen at y 100, `up` above and `down` below. */
const quadOf = (up: number, down: number) => [10, 100 - up, 20, 100 - up, 10, 100 + down, 20, 100 + down]

describe('saneQuad', () => {
  it('leaves an ordinary glyph exactly as MuPDF gave it', () => {
    const q = quadOf(11.4, 2.7) // Cambria at 12pt
    expect(saneQuad(q, [10, 100], 12)).toEqual(q)
  })

  it('leaves a tall but plausible glyph alone', () => {
    const q = quadOf(16, 6) // 1.8x the size: a tall script face
    expect(saneQuad(q, [10, 100], 12)).toEqual(q)
  })

  /**
   * The reported letter: a subset declaring ascent 3117 / descent -2464
   * made every 12pt glyph 67pt tall, so the line swallowed the next one.
   */
  it('pulls a broken font\'s 67pt box back to the line', () => {
    const fixed = saneQuad(quadOf(37.4, 29.6), [10, 100], 12)
    expect(fixed[1]).toBeCloseTo(100 - ASCENT * 12)
    expect(fixed[5]).toBeCloseTo(100 + DESCENT * 12)
    // Its width along the line is untouched.
    expect([fixed[0], fixed[2], fixed[4], fixed[6]]).toEqual([10, 20, 10, 20])
  })

  it('corrects a turned run along its own axis', () => {
    // Text running down the page: "up" points towards -x.
    const q = [60, 10, 60, 20, 140, 10, 140, 20] // 80 tall across, pen at x 100
    const fixed = saneQuad(q, [100, 10], 12)
    expect(fixed[0]).toBeCloseTo(100 - ASCENT * 12)
    expect(fixed[4]).toBeCloseTo(100 + DESCENT * 12)
    expect([fixed[1], fixed[3], fixed[5], fixed[7]]).toEqual([10, 20, 10, 20])
  })

  it('does nothing without a size to judge by', () => {
    const q = quadOf(37.4, 29.6)
    expect(saneQuad(q, [10, 100], 0)).toEqual(q)
  })
})
