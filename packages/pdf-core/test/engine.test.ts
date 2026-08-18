import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { PdfDocument } from '../src/index.js'
import { generateFixtures, fixturePath } from './fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)

const bytes = (n: Parameters<typeof fixturePath>[0]) => new Uint8Array(readFileSync(fixturePath(n)))

describe('PdfDocument.open', () => {
  it('reports the page count', () => {
    const doc = PdfDocument.open(bytes('multi-page'))
    expect(doc.pageCount).toBe(12)
    doc.close()
  })

  it('handles a 300-page document', () => {
    const doc = PdfDocument.open(bytes('large-300p'))
    expect(doc.pageCount).toBe(300)
    doc.close()
  })

  it('reports no password needed for a plain document', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    expect(doc.needsPassword()).toBe(false)
    doc.close()
  })

  it('throws a typed error on non-PDF input', () => {
    expect(() => PdfDocument.open(new Uint8Array([1, 2, 3, 4]))).toThrow()
  })

  it('is safe to close twice', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    doc.close()
    expect(() => doc.close()).not.toThrow()
  })

  it('rejects use after close', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    doc.close()
    expect(() => doc.pageGeometry(0)).toThrow(/closed/i)
  })
})
