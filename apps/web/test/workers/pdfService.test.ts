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

describe('PdfService.save', () => {
  it('returns the exact source bytes for an unedited document', () => {
    const svc = new PdfService()
    const src = bytes('simple-text')
    svc.open(src.slice())
    expect(Array.from(svc.save())).toEqual(Array.from(src))
  })

  // Guards against a future transfer handler neutering the worker's own
  // copy on the way out. If save() ever hands back the retained buffer as a
  // Transferable, the SECOND call throws or returns an empty array.
  it('can be called twice', () => {
    const svc = new PdfService()
    svc.open(bytes('simple-text'))
    const a = svc.save()
    const b = svc.save()
    expect(a.byteLength).toBeGreaterThan(0)
    expect(Array.from(b)).toEqual(Array.from(a))
  })

  it('throws when no document is open', () => {
    expect(() => new PdfService().save()).toThrow('no document open')
  })

  it('drops the retained bytes on close', () => {
    const svc = new PdfService()
    svc.open(bytes('simple-text'))
    svc.close()
    expect(() => svc.save()).toThrow('no document open')
  })

  // Task 24 routed save() through replay(). The no-objects path must stay a
  // pass-through of the original file: e2e/download.spec.ts asserts the
  // downloaded bytes are identical to the opened fixture, and a MuPDF
  // re-serialisation would break that even though it renders the same.
  it('still returns the original bytes when the edit document is empty', () => {
    const svc = new PdfService()
    const src = bytes('simple-text')
    svc.open(src.slice())
    const empty = {
      version: 1, sourceHash: '', pageOrder: ['p0'],
      pages: { p0: { sourceIndex: 0 } }, objects: {}, nextZ: 1,
    }
    expect(Array.from(svc.save(empty))).toEqual(Array.from(src))
  })

  // The other side of that branch: once there IS an object, save() must go
  // through replay -- and replay refuses a kind it has no writer for rather
  // than silently exporting a document missing the user's edit.
  it('routes through replay once the edit document has objects', () => {
    const svc = new PdfService()
    svc.open(bytes('simple-text'))
    const edits = {
      version: 1, sourceHash: '', pageOrder: ['p0'],
      pages: { p0: { sourceIndex: 0 } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      objects: { a1: { id: 'a1', pageId: 'p0', kind: 'rect', z: 1 } as any },
      nextZ: 2,
    }
    expect(() => svc.save(edits)).toThrow(/no writer registered/)
  })
})
