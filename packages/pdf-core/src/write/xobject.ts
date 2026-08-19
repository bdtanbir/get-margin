import type * as mupdf from 'mupdf'

/**
 * FNV-1a over the bytes. Not cryptographic and does not need to be: this
 * only decides whether two payloads are the same embedded resource, and a
 * collision would reuse one image for another -- which the length check
 * below makes vanishingly unlikely for the sizes involved.
 */
function hash(bytes: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(16)}-${bytes.length}`
}

export type XObjectCache = (
  bytes: Uint8Array,
  create: () => mupdf.PDFObject,
) => { name: string; obj: mupdf.PDFObject }

/**
 * Embed-once memo for image XObjects, keyed by payload rather than by object
 * id: the same photo placed on ten pages is one embedded stream referenced
 * ten times, not ten copies. Names are per document (`Im1`, `Im2`, ...) and
 * are registered into each page's /Resources by the caller, since a resource
 * dictionary is per page while the underlying object is not.
 */
export function createXObjectCache(): XObjectCache {
  const cache = new Map<string, { name: string; obj: mupdf.PDFObject }>()
  return (bytes, create) => {
    const key = hash(bytes)
    const hit = cache.get(key)
    if (hit) return hit
    const entry = { name: `Im${cache.size + 1}`, obj: create() }
    cache.set(key, entry)
    return entry
  }
}
