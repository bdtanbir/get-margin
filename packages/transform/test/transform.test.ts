import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  pageSizePt, pageViewSize, pdfToView, viewToPdf, pdfRectToView, viewRectToPdf, pageRectToView,
  svgViewBox, svgRootTransform, normalizeRotation, rectFromPoints, directedRect,
  type PageGeometry, type Rotation,
} from '../src/index.js'

const LETTER: PageGeometry = { cropBox: [0, 0, 612, 792], rotate: 0 }

describe('pageSizePt', () => {
  it('returns cropBox extent, not corner coordinates', () => {
    expect(pageSizePt({ cropBox: [50, 80, 400, 500], rotate: 0 })).toEqual({ w: 350, h: 420 })
  })
})

describe('pageViewSize', () => {
  it('scales by zoom', () => {
    expect(pageViewSize(LETTER, 2)).toEqual({ width: 1224, height: 1584 })
  })

  it('swaps dimensions for quarter turns', () => {
    expect(pageViewSize({ ...LETTER, rotate: 90 }, 1)).toEqual({ width: 792, height: 612 })
    expect(pageViewSize({ ...LETTER, rotate: 270 }, 1)).toEqual({ width: 792, height: 612 })
  })

  it('preserves dimensions for half turns', () => {
    expect(pageViewSize({ ...LETTER, rotate: 180 }, 1)).toEqual({ width: 612, height: 792 })
  })
})

/**
 * MuPDF PAGE space -- top-down, CropBox origin already at (0,0), /Rotate
 * already applied. It is the space the extraction quads come in, and it is
 * exactly what the overlay's viewBox describes, so the only thing between
 * it and view pixels is the zoom.
 */
describe('pageRectToView', () => {
  it('scales by zoom without flipping y', () => {
    expect(pageRectToView({ x: 100, y: 40, w: 80, h: 10 }, LETTER, 2))
      .toEqual({ x: 200, y: 80, w: 160, h: 20 })
  })

  // The distinction this function exists for: the same numbers read as PDF
  // space land at the mirror image of where they belong.
  it('is not the same as reading the rect as bottom-up PDF space', () => {
    const r = { x: 100, y: 40, w: 80, h: 10 }
    expect(pageRectToView(r, LETTER, 1).y).toBe(40)
    expect(pdfRectToView(r, LETTER, 1).y).toBe(792 - 40 - 10)
  })

  // Page space already has /Rotate applied, so a rotated page needs no
  // further work here -- unlike pdfRectToView, which rotates raw PDF coords.
  it('leaves a rotated page alone, because page space is already rotated', () => {
    expect(pageRectToView({ x: 10, y: 20, w: 30, h: 40 }, { ...LETTER, rotate: 90 }, 1))
      .toEqual({ x: 10, y: 20, w: 30, h: 40 })
  })
})

describe('pdfToView — anchor cases', () => {
  // PDF origin is bottom-left; view origin is top-left. These four assertions
  // pin the y-flip, which every other case depends on.
  it('maps the PDF bottom-left corner to the view bottom-left', () => {
    expect(pdfToView({ x: 0, y: 0 }, LETTER, 1)).toEqual({ x: 0, y: 792 })
  })

  it('maps the PDF top-left corner to the view origin', () => {
    expect(pdfToView({ x: 0, y: 792 }, LETTER, 1)).toEqual({ x: 0, y: 0 })
  })

  it('subtracts a non-zero cropBox origin', () => {
    const g: PageGeometry = { cropBox: [50, 80, 400, 500], rotate: 0 }
    // (50,500) is the cropBox top-left → view origin
    expect(pdfToView({ x: 50, y: 500 }, g, 1)).toEqual({ x: 0, y: 0 })
    // (50,80) is the cropBox bottom-left → view (0, height)
    expect(pdfToView({ x: 50, y: 80 }, g, 1)).toEqual({ x: 0, y: 420 })
  })

  it('applies zoom after normalization', () => {
    expect(pdfToView({ x: 100, y: 692 }, LETTER, 2)).toEqual({ x: 200, y: 200 })
  })
})

describe('pdfToView — rotation', () => {
  // /Rotate N means "display the page rotated N degrees CLOCKWISE".
  // Content at the unrotated top-left therefore appears at the top-right when N=90.
  it('rotate 90 sends the unrotated top-left to the view top-right', () => {
    const g: PageGeometry = { ...LETTER, rotate: 90 }
    const { width } = pageViewSize(g, 1)
    const v = pdfToView({ x: 0, y: 792 }, g, 1)
    expect(v).toEqual({ x: width, y: 0 })
  })

  it('rotate 180 sends the unrotated top-left to the view bottom-right', () => {
    const g: PageGeometry = { ...LETTER, rotate: 180 }
    const { width, height } = pageViewSize(g, 1)
    expect(pdfToView({ x: 0, y: 792 }, g, 1)).toEqual({ x: width, y: height })
  })

  it('rotate 270 sends the unrotated top-left to the view bottom-left', () => {
    const g: PageGeometry = { ...LETTER, rotate: 270 }
    const { height } = pageViewSize(g, 1)
    expect(pdfToView({ x: 0, y: 792 }, g, 1)).toEqual({ x: 0, y: height })
  })

  it('keeps every rotated point inside the view box', () => {
    for (const rotate of [0, 90, 180, 270] as Rotation[]) {
      const g: PageGeometry = { ...LETTER, rotate }
      const { width, height } = pageViewSize(g, 1)
      for (const p of [{ x: 0, y: 0 }, { x: 612, y: 0 }, { x: 0, y: 792 }, { x: 612, y: 792 }]) {
        const v = pdfToView(p, g, 1)
        expect(v.x).toBeGreaterThanOrEqual(-0.001)
        expect(v.y).toBeGreaterThanOrEqual(-0.001)
        expect(v.x).toBeLessThanOrEqual(width + 0.001)
        expect(v.y).toBeLessThanOrEqual(height + 0.001)
      }
    }
  })
})

describe('normalizeRotation', () => {
  it('wraps and snaps to quarter turns', () => {
    expect(normalizeRotation(0)).toBe(0)
    expect(normalizeRotation(90)).toBe(90)
    expect(normalizeRotation(360)).toBe(0)
    expect(normalizeRotation(450)).toBe(90)
    expect(normalizeRotation(-90)).toBe(270)
    expect(normalizeRotation(-450)).toBe(270)
  })
})

describe('svgViewBox', () => {
  it('uses the displayed (post-rotation) extent in points, with a zero origin', () => {
    // The viewBox must agree with svgRootTransform(), which maps content into
    // the ROTATED extent — so on a quarter turn, viewBox swaps width/height
    // relative to the unrotated cropBox. This is what lets objects render at
    // their raw stored coords with no per-object math.
    expect(svgViewBox({ cropBox: [50, 80, 400, 500], rotate: 90 })).toBe('0 0 420 350')
  })

  it('keeps the unrotated extent when rotate is 0', () => {
    expect(svgViewBox({ cropBox: [50, 80, 400, 500], rotate: 0 })).toBe('0 0 350 420')
  })
})

// ---- Property tests: the real defense ----

const arbGeometry = fc.record({
  cropBox: fc
    .tuple(
      fc.integer({ min: -200, max: 200 }),
      fc.integer({ min: -200, max: 200 }),
      fc.integer({ min: 20, max: 2000 }),
      fc.integer({ min: 20, max: 2000 }),
    )
    .map(([x0, y0, w, h]) => [x0, y0, x0 + w, y0 + h] as [number, number, number, number]),
  rotate: fc.constantFrom<Rotation>(0, 90, 180, 270),
})

const arbZoom = fc.double({ min: 0.1, max: 8, noNaN: true, noDefaultInfinity: true })

describe('property: pdfToView and viewToPdf are inverses', () => {
  it('round-trips any point through any geometry and zoom', () => {
    fc.assert(
      fc.property(arbGeometry, arbZoom, fc.double({ min: -3000, max: 3000, noNaN: true }), fc.double({ min: -3000, max: 3000, noNaN: true }),
        (g, zoom, x, y) => {
          const back = viewToPdf(pdfToView({ x, y }, g, zoom), g, zoom)
          expect(back.x).toBeCloseTo(x, 6)
          expect(back.y).toBeCloseTo(y, 6)
        }),
      { numRuns: 2000 },
    )
  })
})

describe('property: rect round-trip preserves area', () => {
  it('keeps width*height invariant under transform and back', () => {
    fc.assert(
      fc.property(arbGeometry, arbZoom,
        fc.record({
          x: fc.double({ min: -500, max: 500, noNaN: true }),
          y: fc.double({ min: -500, max: 500, noNaN: true }),
          w: fc.double({ min: 1, max: 800, noNaN: true }),
          h: fc.double({ min: 1, max: 800, noNaN: true }),
        }),
        (g, zoom, r) => {
          const back = viewRectToPdf(pdfRectToView(r, g, zoom), g, zoom)
          expect(back.x).toBeCloseTo(r.x, 5)
          expect(back.y).toBeCloseTo(r.y, 5)
          expect(back.w).toBeCloseTo(r.w, 5)
          expect(back.h).toBeCloseTo(r.h, 5)
        }),
      { numRuns: 2000 },
    )
  })
})

describe('property: rects stay non-negative in view space', () => {
  it('never produces a negative width or height', () => {
    fc.assert(
      fc.property(arbGeometry, arbZoom,
        fc.record({
          x: fc.double({ min: -500, max: 500, noNaN: true }),
          y: fc.double({ min: -500, max: 500, noNaN: true }),
          w: fc.double({ min: 1, max: 800, noNaN: true }),
          h: fc.double({ min: 1, max: 800, noNaN: true }),
        }),
        (g, zoom, r) => {
          const v = pdfRectToView(r, g, zoom)
          expect(v.w).toBeGreaterThan(0)
          expect(v.h).toBeGreaterThan(0)
        }),
      { numRuns: 1000 },
    )
  })
})

// ---- Amendment 1: cross-check against MuPDF's real composed matrices ----
//
// A Task 3 spike measured page.getTransform() directly against a running MuPDF
// engine for a 612x792 page with cropBox [0,0,612,792], for all four rotations.
// These numbers are ground truth from the engine, not a re-derivation of the
// brief's math — if this suite fails, the bug is in this module's transcription
// of the formulas, not in the matrices below.
//
// Matrix form: [a, b, c, d, e, f] maps x' = a*x + c*y + e, y' = b*x + d*y + f.
describe('cross-check: pdfToView agrees with MuPDF getTransform()', () => {
  const PAGE: PageGeometry = { cropBox: [0, 0, 612, 792], rotate: 0 }

  const matrices: Record<Rotation, [number, number, number, number, number, number]> = {
    0: [1, 0, 0, -1, 0, 792],
    90: [0, 1, 1, 0, 0, 0],
    180: [-1, 0, 0, 1, 612, 0],
    270: [0, -1, -1, 0, 792, 612],
  }

  function applyMatrix(
    [a, b, c, d, e, f]: [number, number, number, number, number, number],
    p: { x: number; y: number },
  ): { x: number; y: number } {
    return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f }
  }

  const samplePoints = [
    { x: 0, y: 0 },
    { x: 612, y: 0 },
    { x: 0, y: 792 },
    { x: 612, y: 792 },
    { x: 306, y: 396 },
    { x: 100, y: 692 },
    { x: 50.5, y: 12.25 },
  ]

  for (const rotate of [0, 90, 180, 270] as Rotation[]) {
    it(`matches MuPDF's matrix for rotate ${rotate}`, () => {
      const g: PageGeometry = { ...PAGE, rotate }
      const matrix = matrices[rotate]
      for (const p of samplePoints) {
        const expected = applyMatrix(matrix, p)
        const actual = pdfToView(p, g, 1)
        expect(actual.x).toBeCloseTo(expected.x, 9)
        expect(actual.y).toBeCloseTo(expected.y, 9)
      }
    })
  }
})

// ---- Amendment 2: verify svgRootTransform by composing its SVG transform list ----
//
// svgRootTransform() returns a string that no type check can validate — a wrong
// composition order type-checks and passes round-trip tests while rendering the
// whole overlay mirrored. This test parses the returned transform list and
// composes it into a single 2D affine matrix, then checks it agrees with
// pdfToView() point-for-point. SVG applies a transform list left-to-right such
// that a point maps as M1 · M2 · ... · p, so we compose by multiplying in the
// order the operations appear (left operation applied last... no: leftmost
// applied to the point LAST is wrong — see composeSvgTransform below for the
// precise rule this follows).

type Affine = [number, number, number, number, number, number] // a b c d e f

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]

function multiply(m1: Affine, m2: Affine): Affine {
  // Composition such that applying the RESULT to a point p equals
  // applying m1 to (m2 applied to p) — i.e. result = m1 ∘ m2.
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ]
}

function applyAffine([a, b, c, d, e, f]: Affine, p: { x: number; y: number }): { x: number; y: number } {
  return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f }
}

/**
 * Parse an SVG transform-list string (only translate/scale/rotate, as produced
 * by svgRootTransform) and compose it into a single affine matrix.
 *
 * SVG semantics: for a list "T1 T2 T3", a point p is mapped as
 * T1(T2(T3(p))) — i.e. the LEFTMOST operation in the string is the OUTERMOST
 * (applied last to the transformed coordinates), matching standard function
 * composition read left-to-right as nested calls. Composing left-to-right
 * through `multiply(accumulated, next)` with `multiply(m1, m2) = m1 ∘ m2`
 * (apply m2 first, then m1) reproduces exactly this.
 */
function composeSvgTransform(transform: string): Affine {
  const ops = transform.match(/(translate|scale|rotate)\(([^)]*)\)/g) ?? []
  let acc: Affine = IDENTITY
  for (const op of ops) {
    const m = /^(translate|scale|rotate)\(([^)]*)\)$/.exec(op)
    if (!m) throw new Error(`unparseable transform op: ${op}`)
    const name = m[1]
    const args = (m[2] ?? '').trim().split(/[\s,]+/).map(Number)
    let mat: Affine
    if (name === 'translate') {
      const tx = args[0] ?? 0
      const ty = args[1] ?? 0
      mat = [1, 0, 0, 1, tx, ty]
    } else if (name === 'scale') {
      const sx = args[0] ?? 1
      const sy = args[1] ?? sx
      mat = [sx, 0, 0, sy, 0, 0]
    } else if (name === 'rotate') {
      const deg = args[0] ?? 0
      const rad = (deg * Math.PI) / 180
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      mat = [cos, sin, -sin, cos, 0, 0]
    } else {
      throw new Error(`unknown transform op: ${name}`)
    }
    acc = multiply(acc, mat)
  }
  return acc
}

describe('cross-check: svgRootTransform composes to the same mapping as pdfToView', () => {
  const geometries: PageGeometry[] = [
    { cropBox: [0, 0, 612, 792], rotate: 0 },
    { cropBox: [0, 0, 612, 792], rotate: 90 },
    { cropBox: [0, 0, 612, 792], rotate: 180 },
    { cropBox: [0, 0, 612, 792], rotate: 270 },
    // non-zero-origin CropBox, all four rotations
    { cropBox: [50, 80, 450, 580], rotate: 0 },
    { cropBox: [50, 80, 450, 580], rotate: 90 },
    { cropBox: [50, 80, 450, 580], rotate: 180 },
    { cropBox: [50, 80, 450, 580], rotate: 270 },
  ]

  const samplePoints = [
    { x: 0, y: 0 },
    { x: 100, y: 50 },
    { x: 306, y: 396 },
    { x: 612, y: 792 },
    { x: 50.5, y: 692.25 },
  ]

  for (const g of geometries) {
    it(`rotate=${g.rotate} cropBox=[${g.cropBox.join(',')}]`, () => {
      const matrix = composeSvgTransform(svgRootTransform(g))
      for (const p of samplePoints) {
        const viaMatrix = applyAffine(matrix, p)
        const viaPdfToView = pdfToView(p, g, 1)
        expect(viaMatrix.x).toBeCloseTo(viaPdfToView.x, 9)
        expect(viaMatrix.y).toBeCloseTo(viaPdfToView.y, 9)
      }
    })
  }
})

describe('rectFromPoints', () => {
  it('normalises a drag started from any corner', () => {
    const expected = { x: 10, y: 20, w: 30, h: 40 }
    expect(rectFromPoints({ x: 10, y: 20 }, { x: 40, y: 60 })).toEqual(expected)
    expect(rectFromPoints({ x: 40, y: 60 }, { x: 10, y: 20 })).toEqual(expected)
    expect(rectFromPoints({ x: 40, y: 20 }, { x: 10, y: 60 })).toEqual(expected)
    expect(rectFromPoints({ x: 10, y: 60 }, { x: 40, y: 20 })).toEqual(expected)
  })

  it('produces a zero-size rect for a click without a drag', () => {
    expect(rectFromPoints({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5, w: 0, h: 0 })
  })
})

describe('directedRect', () => {
  // A right-to-left arrow must keep its head on the left end; normalising
  // would move it to the right and silently reverse what the user drew.
  it('keeps the drag direction in the sign of w and h', () => {
    expect(directedRect({ x: 40, y: 60 }, { x: 10, y: 20 })).toEqual({ x: 40, y: 60, w: -30, h: -40 })
  })

  it('agrees with rectFromPoints once normalised', () => {
    const a = { x: 40, y: 60 }
    const b = { x: 10, y: 20 }
    const d = directedRect(a, b)
    expect({ x: Math.min(d.x, d.x + d.w), y: Math.min(d.y, d.y + d.h), w: Math.abs(d.w), h: Math.abs(d.h) })
      .toEqual(rectFromPoints(a, b))
  })
})
