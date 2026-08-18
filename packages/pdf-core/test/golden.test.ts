import { describe, it, expect, beforeAll, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { assertGolden, renderToPng } from './golden.js'
import { generateFixtures, fixturePath } from './fixtures/index.js'

/** Same layout golden.ts uses internally — this file lives in the same directory. */
const goldenFile = (name: string) => join(fileURLToPath(new URL('.', import.meta.url)), 'golden', `${name}.png`)

async function mutate(): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes('simple-text'))
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.getPage(0).drawText('UNEXPECTED CONTENT', { x: 72, y: 400, size: 36, font })
  doc.setCreationDate(new Date('2020-01-01T00:00:00Z'))
  doc.setModificationDate(new Date('2020-01-01T00:00:00Z'))
  return doc.save({ useObjectStreams: false })
}

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

describe('golden rig — creation and rebaseline are distinguishable from a real match', () => {
  // Amendment 3: "passed because it matched" must be distinguishable from
  // "passed because there was nothing to match against." Nothing in the
  // committed suite protected the console.warn on the create-on-missing path
  // (it could be deleted in a refactor and every other test would still pass,
  // silently restoring the exact failure mode this rig exists to prevent) or
  // the rebaseline-summary warning added for UPDATE_GOLDENS=1. These tests
  // spy on console.warn directly rather than only checking assertGolden
  // resolves, and each cleans up the golden file it creates so the suite
  // stays idempotent and no stray file gets committed.

  it('warns loudly when a golden is created for the first time', async () => {
    const name = `_scratch-warn-on-create-${process.pid}`
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(assertGolden(name, bytes('simple-text'))).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toMatch(
        new RegExp(`created ${name}\\.png.*REVIEW IT BY EYE`, 'i'),
      )
    } finally {
      warn.mockRestore()
      await unlink(goldenFile(name))
    }
  })

  it('prints nothing when a golden already matches (real comparison, not creation)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // simple-text-p0 already exists and matches by this point in the suite.
      await expect(assertGolden('simple-text-p0', bytes('simple-text'))).resolves.toBeUndefined()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('prints a rebaseline summary with real diff figures when UPDATE_GOLDENS overwrites a differing golden', async () => {
    const name = `_scratch-rebaseline-${process.pid}`
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Establish a baseline first, without UPDATE_GOLDENS, so there is a
    // previous golden for the overwrite to be measured against. Silenced by
    // the same spy — its "created" warning is expected setup noise, not the
    // thing under test here.
    await assertGolden(name, bytes('simple-text'))
    warn.mockClear()

    const previousEnv = process.env.UPDATE_GOLDENS
    process.env.UPDATE_GOLDENS = '1'
    try {
      await expect(assertGolden(name, await mutate())).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      const message = warn.mock.calls[0]?.[0] as string
      expect(message).toMatch(new RegExp(`REBASELINED ${name}\\.png:.*pixels`, 'i'))
      // The message must carry real figures, not just an announcement.
      expect(message).toMatch(/\d+\/\d+ pixels \(\d+\.\d{3}%\)/)
    } finally {
      if (previousEnv === undefined) delete process.env.UPDATE_GOLDENS
      else process.env.UPDATE_GOLDENS = previousEnv
      warn.mockRestore()
      await unlink(goldenFile(name))
    }
  })

  it('rejects a golden name that could escape the golden directory', async () => {
    await expect(assertGolden('../escape', bytes('simple-text'))).rejects.toThrow(/must not contain/i)
    await expect(assertGolden('nested/name', bytes('simple-text'))).rejects.toThrow(/must not contain/i)
  })

  it('rejects a missing golden under CI instead of silently creating one', async () => {
    const name = `_scratch-ci-missing-${process.pid}`
    const previousCI = process.env.CI
    process.env.CI = '1'
    try {
      await expect(assertGolden(name, bytes('simple-text'))).rejects.toThrow(
        /no committed golden for/i,
      )
    } finally {
      if (previousCI === undefined) delete process.env.CI
      else process.env.CI = previousCI
    }
    // Nothing should have been written under CI — confirm no stray file needs cleanup.
    expect(existsSync(goldenFile(name))).toBe(false)
  })
})
