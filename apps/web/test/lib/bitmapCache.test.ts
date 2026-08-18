import { describe, it, expect } from 'vitest'
import { BitmapCache, cacheKey } from '../../src/lib/bitmapCache.js'

function bmp(w: number, h: number) {
  // page/scale are unused by every test below, but RenderResult requires
  // them — filled with harmless constants so this satisfies the type.
  return { width: w, height: h, rgba: new Uint8Array(w * h * 4), page: 0, scale: 1 }
}
const MP = (w: number, h: number) => (w * h) / 1_000_000

describe('cacheKey', () => {
  it('combines page id and scale', () => {
    expect(cacheKey('abc', 2)).toBe('abc@2')
  })

  it('rounds scale so float drift does not fragment the cache', () => {
    // 1.9999999 and 2 must not be separate entries.
    expect(cacheKey('abc', 1.9999999)).toBe(cacheKey('abc', 2))
  })
})

describe('BitmapCache', () => {
  it('stores and retrieves by key', () => {
    const c = new BitmapCache(100)
    c.set('a@1', bmp(10, 10))
    expect(c.get('a@1')?.width).toBe(10)
    expect(c.has('a@1')).toBe(true)
  })

  it('tracks total megapixels', () => {
    const c = new BitmapCache(100)
    c.set('a@1', bmp(1000, 1000))
    expect(c.megapixels).toBeCloseTo(1, 5)
  })

  it('evicts the least recently used entry when over budget', () => {
    const c = new BitmapCache(MP(1000, 1000) * 2.5) // room for two 1MP entries
    c.set('a@1', bmp(1000, 1000))
    c.set('b@1', bmp(1000, 1000))
    c.set('c@1', bmp(1000, 1000))
    expect(c.has('a@1')).toBe(false)
    expect(c.has('b@1')).toBe(true)
    expect(c.has('c@1')).toBe(true)
  })

  it('treats a get as a use, protecting the entry from eviction', () => {
    const c = new BitmapCache(MP(1000, 1000) * 2.5)
    c.set('a@1', bmp(1000, 1000))
    c.set('b@1', bmp(1000, 1000))
    c.get('a@1')                       // a is now the most recent
    c.set('c@1', bmp(1000, 1000))
    expect(c.has('a@1')).toBe(true)
    expect(c.has('b@1')).toBe(false)
  })

  it('accepts an entry larger than the whole budget without evicting into an empty cache forever', () => {
    const c = new BitmapCache(1)
    c.set('huge@4', bmp(4000, 4000)) // 16MP into a 1MP budget
    // Storing it is correct — the user is looking at it. It must simply be the
    // only thing there, and must not loop forever trying to evict.
    expect(c.has('huge@4')).toBe(true)
    expect(c.size).toBe(1)
  })

  it('invalidatePage drops every scale for that page only', () => {
    const c = new BitmapCache(100)
    c.set(cacheKey('p1', 1), bmp(10, 10))
    c.set(cacheKey('p1', 2), bmp(20, 20))
    c.set(cacheKey('p2', 1), bmp(10, 10))
    c.invalidatePage('p1')
    expect(c.has(cacheKey('p1', 1))).toBe(false)
    expect(c.has(cacheKey('p1', 2))).toBe(false)
    expect(c.has(cacheKey('p2', 1))).toBe(true)
  })

  it('clear empties the cache and resets the megapixel count', () => {
    const c = new BitmapCache(100)
    c.set('a@1', bmp(1000, 1000))
    c.clear()
    expect(c.size).toBe(0)
    expect(c.megapixels).toBe(0)
  })

  it('overwriting a key does not double-count its pixels', () => {
    const c = new BitmapCache(100)
    c.set('a@1', bmp(1000, 1000))
    c.set('a@1', bmp(1000, 1000))
    expect(c.megapixels).toBeCloseTo(1, 5)
    expect(c.size).toBe(1)
  })
})
