import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  FONTS, SIGNATURE_FACES, DEFAULT_FAMILY, fontUrl, cssFamily, fontBytes, fontsForExport,
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
