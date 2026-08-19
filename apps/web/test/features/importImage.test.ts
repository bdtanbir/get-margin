import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  importImage, fitWithin, placementRect, MAX_INPUT_BYTES, MAX_EDGE,
} from '@/features/tools/importImage'

describe('fitWithin', () => {
  it('never upscales a small image', () => {
    expect(fitWithin(100, 50)).toEqual({ w: 100, h: 50 })
  })

  it('caps the longest edge and preserves the aspect ratio', () => {
    expect(fitWithin(4000, 3000)).toEqual({ w: 2000, h: 1500 })
    expect(fitWithin(3000, 4000)).toEqual({ w: 1500, h: 2000 })
  })

  it('never rounds an edge down to zero', () => {
    expect(fitWithin(10000, 1, 100).h).toBe(1)
  })
})

describe('placementRect', () => {
  it('centres the image on the given point', () => {
    const r = placementRect({ w: 200, h: 100 }, { x: 300, y: 400 })
    expect(r).toEqual({ x: 200, y: 350, w: 200, h: 100 })
  })

  // A 4000px screenshot treated as 4000pt would be five pages wide.
  it('caps a huge image to a plausible on-page size', () => {
    const r = placementRect({ w: 2000, h: 1000 }, { x: 300, y: 400 })
    expect(r.w).toBe(300)
    expect(r.h).toBe(150)
  })
})

describe('importImage', () => {
  const PNG_BYTES = new Uint8Array([1, 2, 3, 4])
  let alpha = false
  let drawn: { w: number; h: number } = { w: 0, h: 0 }
  const close = vi.fn()

  function file(type: string, size: number): File {
    const f = new File([new Uint8Array(4)], 'photo', { type })
    Object.defineProperty(f, 'size', { value: size })
    return f
  }

  beforeEach(() => {
    alpha = false
    close.mockClear()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4000, height: 3000, close })))
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected ${tag}`)
      const canvas = {
        width: 0, height: 0,
        getContext: () => ({
          drawImage: (_b: unknown, _x: number, _y: number, w: number, h: number) => { drawn = { w, h } },
          getImageData: (_x: number, _y: number, w: number, h: number) => ({
            data: new Uint8ClampedArray(w * h * 4).fill(alpha ? 128 : 255),
          }),
        }),
        toBlob: (cb: (b: Blob) => void, mime: string) => {
          canvas.lastMime = mime
          cb(new Blob([PNG_BYTES], { type: mime }))
        },
        lastMime: '',
      }
      return canvas as unknown as HTMLElement
    }) as typeof document.createElement)
  })

  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('refuses a file that is not an image', async () => {
    await expect(importImage(file('application/pdf', 1000))).rejects.toThrow(/not an image/)
  })

  // The reported size must not round to the same number as the cap, or the
  // message reads "That image is 25 MB ... up to 25 MB".
  it('refuses an image over the input cap and states both sizes distinctly', async () => {
    await expect(importImage(file('image/jpeg', MAX_INPUT_BYTES + 1)))
      .rejects.toThrow('That image is 25.0 MB. The editor places images up to 25 MB.')
    await expect(importImage(file('image/jpeg', 40 * 1024 * 1024)))
      .rejects.toThrow(/40\.0 MB/)
  })

  // Spec 2.1: a 12MP phone photo must not become a multi-megabyte embed.
  it('downscales the longest edge to the cap', async () => {
    const out = await importImage(file('image/jpeg', 5_000_000))
    expect(out.w).toBe(MAX_EDGE)
    expect(out.h).toBe(1500)
    expect(drawn).toEqual({ w: 2000, h: 1500 })
  })

  it('re-encodes an opaque image as JPEG', async () => {
    expect((await importImage(file('image/png', 1000))).mime).toBe('image/jpeg')
  })

  // JPEG has no alpha channel, so a transparent logo re-encoded as JPEG
  // gains a black background nobody asked for.
  it('keeps a transparent image as PNG', async () => {
    alpha = true
    expect((await importImage(file('image/png', 1000))).mime).toBe('image/png')
  })

  it('applies EXIF orientation while decoding', async () => {
    await importImage(file('image/jpeg', 1000))
    expect(createImageBitmap).toHaveBeenCalledWith(
      expect.anything(),
      { imageOrientation: 'from-image' },
    )
  })

  // An ImageBitmap holds a decoded full-resolution surface; a dozen imports
  // without closing them runs the tab out of memory.
  it('releases the decoded bitmap', async () => {
    await importImage(file('image/jpeg', 1000))
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('releases the bitmap even when encoding fails', async () => {
    vi.spyOn(document, 'createElement').mockImplementation((() => ({
      width: 0, height: 0, getContext: () => null,
    }) as unknown as HTMLElement) as typeof document.createElement)
    await expect(importImage(file('image/jpeg', 1000))).rejects.toThrow()
    expect(close).toHaveBeenCalledTimes(1)
  })
})
