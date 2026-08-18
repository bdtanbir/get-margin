import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { assertGolden, renderToPng } from './golden.js'
import { generateFixtures, fixturePath } from './fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)

const bytes = (n: Parameters<typeof fixturePath>[0]) => new Uint8Array(readFileSync(fixturePath(n)))

describe('golden rig', () => {
  it('renders a PDF to a PNG buffer', async () => {
    const png = await renderToPng(bytes('simple-text'), 0, 1)
    // PNG magic number.
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(png.length).toBeGreaterThan(1000)
  })

  it('passes when output matches the golden', async () => {
    await expect(assertGolden('simple-text-p0', bytes('simple-text'))).resolves.toBeUndefined()
  })

  it('passes on a repeat run (renders are deterministic)', async () => {
    await expect(assertGolden('simple-text-p0', bytes('simple-text'))).resolves.toBeUndefined()
  })

  it('fails loudly when the document changes', async () => {
    // Same golden name, visibly different content — the rig must reject this.
    const doc = await PDFDocument.load(bytes('simple-text'))
    const font = await doc.embedFont(StandardFonts.Helvetica)
    doc.getPage(0).drawText('UNEXPECTED CONTENT', { x: 72, y: 400, size: 36, font })
    doc.setCreationDate(new Date('2020-01-01T00:00:00Z'))
    doc.setModificationDate(new Date('2020-01-01T00:00:00Z'))
    const mutated = await doc.save({ useObjectStreams: false })

    await expect(assertGolden('simple-text-p0', mutated)).rejects.toThrow(/differs from golden/i)
  })

  it('respects the page option', async () => {
    await expect(assertGolden('multi-page-p5', bytes('multi-page'), { page: 5 })).resolves.toBeUndefined()
  })
})
