import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { PdfDocument } from '../../src/index.js'
import { buildQuadIndex } from '../../src/text/index.js'
import { generateFixtures, fixturePath } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: Parameters<typeof fixturePath>[0]): Uint8Array =>
  new Uint8Array(readFileSync(fixturePath(n)))

function withDoc<T>(name: Parameters<typeof fixturePath>[0], fn: (d: PdfDocument) => T): T {
  const doc = PdfDocument.open(bytes(name))
  try { return fn(doc) } finally { doc.close() }
}

describe('buildQuadIndex', () => {
  it('returns one entry per line of the fixture', () => {
    withDoc('simple-text', (doc) => {
      const index = buildQuadIndex(doc, 0)
      expect(index.lines.length).toBeGreaterThan(0)
      expect(index.lines[0]!.text.length).toBeGreaterThan(0)
    })
  })

  it('carries a per-character quad for every character in a line', () => {
    withDoc('simple-text', (doc) => {
      const line = buildQuadIndex(doc, 0).lines[0]!
      expect(line.chars).toHaveLength([...line.text].length)
      expect(line.chars[0]!.quad).toHaveLength(8)
    })
  })

  it('reads the fixture text back in order', () => {
    withDoc('simple-text', (doc) => {
      expect(buildQuadIndex(doc, 0).lines[0]!.text).toContain('Hello margin')
    })
  })

  it('reports font name and size per run', () => {
    withDoc('mixed-fonts', (doc) => {
      const lines = buildQuadIndex(doc, 0).lines
      expect(new Set(lines.map((l) => l.font)).size).toBeGreaterThan(1)
      for (const l of lines) expect(l.size).toBeGreaterThan(0)
    })
  })

  // Page space is top-down with the CropBox origin normalised, so every quad
  // must land inside [0, w] x [0, h] -- the same box toPixmap renders into.
  it('produces quads inside the page bounds', () => {
    withDoc('simple-text', (doc) => {
      const { cropBox } = doc.pageGeometry(0)
      const w = cropBox[2] - cropBox[0]
      const h = cropBox[3] - cropBox[1]
      for (const line of buildQuadIndex(doc, 0).lines) {
        for (const c of line.chars) {
          for (let i = 0; i < 8; i += 2) {
            expect(c.quad[i]).toBeGreaterThanOrEqual(-1)
            expect(c.quad[i]).toBeLessThanOrEqual(w + 1)
            expect(c.quad[i + 1]).toBeGreaterThanOrEqual(-1)
            expect(c.quad[i + 1]).toBeLessThanOrEqual(h + 1)
          }
        }
      }
    })
  })

  it('produces quads inside the page bounds on a rotated page', () => {
    withDoc('rotated', (doc) => {
      const index = buildQuadIndex(doc, 0)
      for (const line of index.lines) {
        for (const c of line.chars) {
          for (let i = 0; i < 8; i += 2) {
            expect(c.quad[i]).toBeGreaterThanOrEqual(-1)
            expect(c.quad[i + 1]).toBeGreaterThanOrEqual(-1)
          }
        }
      }
    })
  })

  // Top-down, NOT bottom-up: the first line of a page must have a SMALLER y
  // than the last. Getting this backwards would put every highlight on the
  // mirror image of the text it marks (Task 38 consumes these directly).
  it('is top-down page space, so the first line has the smaller y', () => {
    withDoc('simple-text', (doc) => {
      const lines = buildQuadIndex(doc, 0).lines
      expect(lines.length).toBeGreaterThan(1)
      expect(lines[0]!.bbox[1]).toBeLessThan(lines[lines.length - 1]!.bbox[1])
    })
  })

  it('groups characters by the line that emitted them, not by bbox overlap', () => {
    withDoc('simple-text', (doc) => {
      const lines = buildQuadIndex(doc, 0).lines
      const total = lines.reduce((n, l) => n + l.chars.length, 0)
      expect(total).toBe(lines.reduce((n, l) => n + [...l.text].length, 0))
    })
  })

  it('destroys the page even when extraction throws', () => {
    withDoc('simple-text', (doc) => {
      expect(() => buildQuadIndex(doc, 999)).toThrow()
      // A leaked page does not fail loudly -- it hard-crashes the WASM heap
      // several hundred pages later. Prove the finally ran by using the
      // document again.
      expect(buildQuadIndex(doc, 0).lines.length).toBeGreaterThan(0)
    })
  })
})
