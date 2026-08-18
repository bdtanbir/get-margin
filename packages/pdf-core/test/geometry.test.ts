import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { PdfDocument } from '../src/index.js'
import { generateFixtures, fixturePath } from './fixtures/index.js'
import { pageSizePt } from '@margin/transform'
import { geometryFromPageObject, type RawObj } from '../src/geometry.js'

beforeAll(async () => { await generateFixtures() }, 60_000)

const bytes = (n: Parameters<typeof fixturePath>[0]) => new Uint8Array(readFileSync(fixturePath(n)))

describe('pageGeometry', () => {
  it('returns US Letter dimensions with a zero origin', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    const g = doc.pageGeometry(0)
    expect(g.cropBox).toEqual([0, 0, 612, 792])
    expect(g.rotate).toBe(0)
    doc.close()
  })

  it('returns the CropBox including a non-zero origin', () => {
    const doc = PdfDocument.open(bytes('offset-cropbox'))
    const g = doc.pageGeometry(0)
    expect(g.cropBox).toEqual([50, 80, 400, 500])
    expect(pageSizePt(g)).toEqual({ w: 350, h: 420 })
    doc.close()
  })

  it('reads /Rotate for each page', () => {
    const doc = PdfDocument.open(bytes('rotated'))
    expect(doc.pageGeometry(0).rotate).toBe(0)
    expect(doc.pageGeometry(1).rotate).toBe(90)
    expect(doc.pageGeometry(2).rotate).toBe(180)
    expect(doc.pageGeometry(3).rotate).toBe(270)
    doc.close()
  })

  it('keeps cropBox unrotated regardless of /Rotate', () => {
    // A rotated page's STORED box is still portrait. Rotation is a view concern.
    const doc = PdfDocument.open(bytes('rotated'))
    expect(doc.pageGeometry(1).cropBox).toEqual([0, 0, 612, 792])
    doc.close()
  })

  it('throws on an out-of-range page index', () => {
    const doc = PdfDocument.open(bytes('multi-page'))
    expect(() => doc.pageGeometry(12)).toThrow(/range/i)
    expect(() => doc.pageGeometry(-1)).toThrow(/range/i)
    doc.close()
  })
})

// --- Amendment 3: min/max box normalisation is load-bearing -----------------
//
// @margin/transform's pdfToView trusts cropBox[0]/[1] to be the box's
// lower-left corner. geometryFromPageObject (via readBox) is where that
// invariant gets established for the whole application, so it is exercised
// directly here with a stub RawObj rather than through a fixture round-trip
// (pdf-lib's setCropBox always writes ascending corners, so a reversed-corner
// fixture cannot easily be authored).

function numObj(n: number): RawObj {
  return {
    get: () => nullObj(),
    isArray: () => false,
    isNumber: () => true,
    asNumber: () => n,
    isNull: () => false,
  }
}

function nullObj(): RawObj {
  const self: RawObj = {
    get: () => self,
    isArray: () => false,
    isNumber: () => false,
    asNumber: () => 0,
    isNull: () => true,
  }
  return self
}

function arrObj(values: number[]): RawObj {
  return {
    get: (key) => (typeof key === 'number' && key >= 0 && key < values.length
      ? numObj(values[key] as number)
      : nullObj()),
    isArray: () => true,
    isNumber: () => false,
    asNumber: () => 0,
    isNull: () => false,
  }
}

function pageStub(dict: Record<string, RawObj>): RawObj {
  return {
    get: (key) => (typeof key === 'string' && key in dict ? (dict[key] as RawObj) : nullObj()),
    isArray: () => false,
    isNumber: () => false,
    asNumber: () => 0,
    isNull: () => false,
  }
}

describe('geometryFromPageObject box normalisation', () => {
  it('normalises a CropBox stored with corners in reverse order', () => {
    const page = pageStub({
      MediaBox: arrObj([0, 0, 612, 792]),
      CropBox: arrObj([400, 500, 50, 80]),
    })
    const g = geometryFromPageObject(page)
    expect(g.cropBox).toEqual([50, 80, 400, 500])
  })
})

// --- /Parent-chain inheritance: no fixture exercises this path -------------
//
// Every fixture page (test/fixtures/generate.ts) is built via pdf-lib's
// addPage(), which always writes /MediaBox (and, for `rotated`, /Rotate)
// directly onto the page dictionary — never onto a shared Pages-tree parent.
// So the real, inheritable-attribute case (legal PDF, common in real files
// per PDF 32000-1 §7.7.3.4) is untested by every fixture-based test above.
// This proves the walk in `inherited()` actually reaches and returns a
// value from the immediate /Parent, not just that it degrades gracefully
// when there's nothing to inherit.
describe('geometryFromPageObject /Parent inheritance', () => {
  it('walks up to /Parent when the page itself omits /MediaBox and /Rotate', () => {
    const parent = pageStub({
      MediaBox: arrObj([0, 0, 612, 792]),
      Rotate: numObj(90),
    })
    const page = pageStub({ Parent: parent })
    const g = geometryFromPageObject(page)
    expect(g.cropBox).toEqual([0, 0, 612, 792])
    expect(g.rotate).toBe(90)
  })

  it('falls back to MediaBox when CropBox/MediaBox intersection is degenerate', () => {
    const page = pageStub({
      MediaBox: arrObj([0, 0, 612, 792]),
      // Zero width (x0 === x1) — a malformed CropBox that must be rejected,
      // not silently produce a zero-area page.
      CropBox: arrObj([100, 100, 100, 500]),
    })
    const g = geometryFromPageObject(page)
    expect(g.cropBox).toEqual([0, 0, 612, 792])
  })
})
