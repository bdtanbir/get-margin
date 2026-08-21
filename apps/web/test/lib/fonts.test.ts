import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  FONTS, SIGNATURE_FACES, DEFAULT_FAMILY, fontUrl, cssFamily, fontBytes, fontsForExport,
  faceFile, faceKey, cssWeight, cssStyle,
} from '@/lib/fonts'
import { ASCENT_RATIO, LINE_HEIGHT } from '@/lib/fonts'

describe('the curated font set', () => {
  it('has a default that is actually in the set', () => {
    expect(FONTS.map((f) => f.family)).toContain(DEFAULT_FAMILY)
  })

  it('maps every family to a self-hosted path, not a CDN', () => {
    // Spec 2.5: opening a document must make no third-party request, and the
    // export must embed the same bytes the preview rendered.
    for (const f of FONTS) {
      const url = fontUrl(f.family)
      expect(url).toBe(`/fonts/${f.file}`)
      expect(url).not.toMatch(/^https?:/)
    }
  })

  it('refuses an unknown family instead of guessing a filename', () => {
    expect(() => fontUrl('Comic Sans')).toThrow(/Comic Sans/)
  })

  it('quotes multi-word families and gives each a generic fallback', () => {
    expect(cssFamily('Source Serif 4')).toBe('"Source Serif 4", serif')
    expect(cssFamily('JetBrains Mono')).toBe('"JetBrains Mono", monospace')
  })

  it('passes an unknown family through rather than throwing while rendering', () => {
    // Called from a render path -- a document referencing a retired family
    // should look wrong, not take the overlay down.
    expect(cssFamily('Nonesuch')).toBe('Nonesuch')
  })

  // These must equal ASCENT_RATIO / LINE_HEIGHT in
  // pdf-core/src/write/objects/text.ts. If they drift, text jumps between
  // the preview and the exported file.
  it('uses the same layout constants as the writer', () => {
    expect(ASCENT_RATIO).toBe(0.8)
    expect(LINE_HEIGHT).toBe(1.2)
  })
})

describe('fontsForExport', () => {
  const original = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      url: String(url),
    })) as unknown as typeof fetch
  })
  afterEach(() => { globalThis.fetch = original })

  it('fetches each family exactly once, however many objects use it', async () => {
    const map = await fontsForExport(['Inter', 'Inter', 'Roboto', 'Inter'])
    expect([...map.keys()].sort()).toEqual(['Inter', 'Roboto'])
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  it('fetches nothing for a document with no text', async () => {
    const map = await fontsForExport([])
    expect(map.size).toBe(0)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('reports a failed font load rather than exporting without it', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch
    await expect(fontBytes('Inter')).rejects.toThrow(/Inter/)
  })
})

// Task 35 Step 4: the typed signature uses SCRIPT faces. A signature typed
// in a body face reads as typed text rather than a signature -- the same
// "feels broken" failure spec 2.1 calls out for an un-cleaned photo.
describe('signature script faces', () => {
  it('offers at least three script faces', () => {
    expect(SIGNATURE_FACES.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps them out of the document text picker', () => {
    const documentFaces = FONTS.map((f) => f.family)
    for (const f of SIGNATURE_FACES) expect(documentFaces).not.toContain(f.family)
  })

  it('resolves each to a self-hosted path', () => {
    for (const f of SIGNATURE_FACES) {
      expect(fontUrl(f.family)).toBe(`/fonts/${f.file}`)
    }
  })

  it('falls back to cursive, not a body generic', () => {
    for (const f of SIGNATURE_FACES) expect(cssFamily(f.family)).toContain('cursive')
  })

  // A typed signature is rasterised to a PNG, so its face is never embedded.
  // Letting one through would silently add ~60KB to a document for a face the
  // writer was never meant to see.
  it('never sends a script face to the export', async () => {
    const original = globalThis.fetch
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1]).buffer,
    })) as unknown as typeof fetch
    try {
      const map = await fontsForExport(['Inter', 'Great Vibes', 'Caveat'])
      expect([...map.keys()]).toEqual(['Inter'])
    } finally {
      globalThis.fetch = original
    }
  })
})

/**
 * `public/fonts`, found by walking up from the working directory.
 *
 * Vitest runs this project from the repo root or from `apps/web` depending
 * on how it was invoked, and `import.meta.url` is not a file: URL under the
 * jsdom transform, so neither one alone locates the directory reliably.
 */
const FONT_DIR = (() => {
  for (const up of ['.', '..', '../..']) {
    const candidate = resolve(process.cwd(), up, 'apps/web/public/fonts')
    if (existsSync(candidate)) return candidate
  }
  const here = resolve(process.cwd(), 'public/fonts')
  if (existsSync(here)) return here
  throw new Error(`could not find public/fonts from ${process.cwd()}`)
})()

/**
 * A bundled font's own declared style, read out of its OS/2 table.
 *
 * Written by hand rather than pulled from a parser because it answers one
 * question and the answer must not depend on a dependency's version. The
 * layout is fixed by the OpenType spec: an sfnt begins with a 12-byte
 * header whose table directory records are 16 bytes each, `usWeightClass`
 * sits at offset 4 of the OS/2 table and `fsSelection` at offset 62, where
 * bit 0 is ITALIC and bit 5 is BOLD.
 *
 * `post.italicAngle` is deliberately NOT consulted: Roboto's italic
 * declares an angle of 0 and is unmistakably slanted, so the angle would
 * fail a face that is fine.
 */
function declaredStyle(file: string): {
  usWeightClass: number
  boldBit: boolean
  italicBit: boolean
} {
  const bytes = new Uint8Array(readFileSync(join(FONT_DIR, file)))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const numTables = view.getUint16(4)
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16
    const tag = String.fromCharCode(...bytes.subarray(record, record + 4))
    if (tag !== 'OS/2') continue
    const at = view.getUint32(record + 8)
    const fsSelection = view.getUint16(at + 62)
    return {
      usWeightClass: view.getUint16(at + 4),
      boldBit: (fsSelection & 0x20) !== 0,
      italicBit: (fsSelection & 0x01) !== 0,
    }
  }
  throw new Error(`${file} has no OS/2 table`)
}

/**
 * Style.
 *
 * THE FILES THEMSELVES, not just the plumbing that points at them. The
 * Google Fonts v1 CSS endpoint takes styles as a bare list (`Inter:700`,
 * `Inter:400italic`) and silently ignores the css2 spelling
 * (`Inter:wght@700`), serving the upright weight 400 instead. What comes
 * back is a perfectly valid TrueType, so the fetch script's magic-number
 * check passes and nothing downstream notices -- every "bold" file in the
 * repo would be a byte-identical regular, and the only symptom would be
 * that ticking Bold changed nothing. That mistake was made once. These
 * assertions are what stop it being made twice, on either axis.
 */
describe('the four styles of each face', () => {
  /** Every body face, in every style, with what that style should declare. */
  const everyFace = FONTS.flatMap((f) => [
    { file: f.file, bold: false, italic: false },
    { file: f.bold, bold: true, italic: false },
    { file: f.italic, bold: false, italic: true },
    { file: f.boldItalic, bold: true, italic: true },
  ])

  it('gives every body face all four files', () => {
    for (const f of FONTS) {
      expect(f.file, f.family).toBeTruthy()
      expect(f.bold, f.family).toBeTruthy()
      expect(f.italic, f.family).toBeTruthy()
      expect(f.boldItalic, f.family).toBeTruthy()
    }
  })

  it('ships files that declare the style their name claims', () => {
    for (const { file, bold, italic } of everyFace) {
      const declared = declaredStyle(file)
      expect(declared.boldBit, `${file} fsSelection BOLD bit`).toBe(bold)
      expect(declared.italicBit, `${file} fsSelection ITALIC bit`).toBe(italic)
      if (bold) {
        expect(declared.usWeightClass, `${file} usWeightClass`).toBeGreaterThanOrEqual(600)
      } else {
        expect(declared.usWeightClass, `${file} usWeightClass`).toBeLessThan(600)
      }
    }
  })

  /**
   * Four distinct files, not one file under four names. A copy-paste in the
   * fetch script would sail past the assertion above, because the same file
   * declares the same correct thing every time it is read.
   */
  it('ships four different files per family', () => {
    for (const f of FONTS) {
      const files = [f.file, f.bold, f.italic, f.boldItalic]
      expect(new Set(files).size, `${f.family} has a repeated file`).toBe(4)
    }
  })

  it('resolves a face to the file for its style', () => {
    expect(faceFile('Inter')).toBe('Inter.ttf')
    expect(faceFile('Inter', { bold: true })).toBe('Inter-Bold.ttf')
    expect(faceFile('Inter', { italic: true })).toBe('Inter-Italic.ttf')
    expect(faceFile('Inter', { bold: true, italic: true })).toBe('Inter-BoldItalic.ttf')
    expect(fontUrl('Inter', { bold: true, italic: true }))
      .toBe('/fonts/Inter-BoldItalic.ttf')
  })

  it('refuses a style a script face has no file for', () => {
    // A silent fallback here would render one face and embed another.
    expect(() => faceFile('Great Vibes', { bold: true })).toThrow(/Great Vibes/)
    expect(() => faceFile('Great Vibes', { italic: true })).toThrow(/Great Vibes/)
  })

  it('addresses faces exactly as the writer does', () => {
    // faceKey is pdf-core's, re-exported. If these two ever disagreed the
    // app would build a provider map the writer could not look anything up
    // in, and every export with a styled object would throw.
    expect(faceKey('Inter', { bold: true })).toBe('Inter Bold')
    expect(faceKey('Inter', { italic: true })).toBe('Inter Italic')
    expect(faceKey('Inter', { bold: true, italic: true })).toBe('Inter Bold Italic')
    expect(faceKey('Inter', { bold: false, italic: false })).toBe('Inter')
    expect(faceKey('Inter')).toBe('Inter')
  })

  /**
   * The suffixes append in ONE order. The key is the face's identity, so
   * two spellings of the same face would embed the same font program twice
   * under two resource names -- and the app and the writer would each pick
   * whichever they built first.
   */
  it('spells a combined style one way only', () => {
    expect(faceKey('Inter', { italic: true, bold: true })).toBe('Inter Bold Italic')
  })

  it('asks CSS for the descriptors it registered the files under', () => {
    expect(cssWeight(true)).toBe('700')
    expect(cssWeight(false)).toBe('400')
    expect(cssWeight()).toBe('400')
    expect(cssStyle(true)).toBe('italic')
    expect(cssStyle(false)).toBe('normal')
    expect(cssStyle()).toBe('normal')
  })

  it('fetches the file each face key names', async () => {
    const original = globalThis.fetch
    const urls: string[] = []
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url))
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1]).buffer }
    }) as unknown as typeof fetch
    try {
      const map = await fontsForExport(['Inter', 'Inter Bold Italic', 'Inter Italic'])
      expect([...map.keys()].sort())
        .toEqual(['Inter', 'Inter Bold Italic', 'Inter Italic'])
      expect(urls.sort()).toEqual([
        '/fonts/Inter-BoldItalic.ttf', '/fonts/Inter-Italic.ttf', '/fonts/Inter.ttf',
      ])
    } finally {
      globalThis.fetch = original
    }
  })
})
