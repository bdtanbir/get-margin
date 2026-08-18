import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { PdfService } from '../../src/workers/pdfService.js'
import { generateFixtures, fixturePath } from '../../../../packages/pdf-core/test/fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)

const bytes = (n: Parameters<typeof fixturePath>[0]) => new Uint8Array(readFileSync(fixturePath(n)))

describe('PdfService.open', () => {
  it('returns page count and geometry for every page', () => {
    const s = new PdfService()
    const info = s.open(bytes('multi-page'))
    expect(info.pageCount).toBe(12)
    expect(info.geometries).toHaveLength(12)
    expect(info.geometries[0]).toEqual({ cropBox: [0, 0, 612, 792], rotate: 0 })
    expect(info.needsPassword).toBe(false)
    s.close()
  })

  it('reports rotation per page', () => {
    const s = new PdfService()
    const info = s.open(bytes('rotated'))
    expect(info.geometries.map((g) => g.rotate)).toEqual([0, 90, 180, 270])
    s.close()
  })

  it('rejects a non-PDF', () => {
    const s = new PdfService()
    expect(() => s.open(new Uint8Array([0, 1, 2, 3]))).toThrow()
    s.close()
  })

  it('closes a previously open document when opening another', () => {
    const s = new PdfService()
    s.open(bytes('simple-text'))
    const info = s.open(bytes('multi-page'))
    expect(info.pageCount).toBe(12)
    s.close()
  })
})

describe('PdfService.render', () => {
  it('renders a requested page', () => {
    const s = new PdfService()
    s.open(bytes('simple-text'))
    const r = s.render({ id: 1, page: 0, scale: 1 })
    expect(r).not.toBeNull()
    expect(r!.width).toBe(612)
    expect(r!.rgba.length).toBe(612 * 792 * 4)
    s.close()
  })

  it('echoes back the page and scale that produced the bitmap', () => {
    // Amendment A2: a virtualised viewer receiving a bitmap from a worker
    // otherwise cannot tell which zoom level produced it.
    const s = new PdfService()
    s.open(bytes('multi-page'))
    const r = s.render({ id: 1, page: 3, scale: 1.5 })
    expect(r).not.toBeNull()
    expect(r!.page).toBe(3)
    expect(r!.scale).toBe(1.5)
    s.close()
  })

  it('throws when no document is open', () => {
    const s = new PdfService()
    expect(() => s.render({ id: 1, page: 0, scale: 1 })).toThrow(/no document/i)
  })
})

describe('PdfService password handling', () => {
  // No encrypted fixture exists yet — Task 5 decides whether we can create
  // one. There is no real password-handling coverage here: this only
  // asserts that `authenticate` exists as a function, which proves nothing
  // about needsPassword or actual authentication. Explicitly skipped so it
  // reads as "not covered yet" everywhere (test runner output, CI, coverage
  // reports) instead of appearing as a passing password test.
  it.skip('surfaces needsPassword and accepts authentication (blocked on an encrypted fixture)', () => {
    expect(typeof new PdfService().authenticate).toBe('function')
  })
})
