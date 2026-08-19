import { describe, it, expect } from 'vitest'
import { unzipSync } from 'fflate'
import { zipFiles } from '@/lib/zip'

describe('zipFiles', () => {
  it('round-trips names and bytes', async () => {
    const out = await zipFiles([
      { name: 'a-1-2.pdf', data: new Uint8Array([1, 2, 3]) },
      { name: 'a-3.pdf', data: new Uint8Array([4, 5]) },
    ])
    const back = unzipSync(out)
    expect(Object.keys(back).sort()).toEqual(['a-1-2.pdf', 'a-3.pdf'])
    expect(Array.from(back['a-1-2.pdf']!)).toEqual([1, 2, 3])
    expect(Array.from(back['a-3.pdf']!)).toEqual([4, 5])
  })

  it('produces a readable archive for a single entry', async () => {
    const out = await zipFiles([{ name: 'only.pdf', data: new Uint8Array([9]) }])
    expect(Object.keys(unzipSync(out))).toEqual(['only.pdf'])
  })

  it('produces an empty but valid archive for no entries', async () => {
    expect(Object.keys(unzipSync(await zipFiles([])))).toEqual([])
  })

  // Stored rather than deflated: a PDF is already compressed, so the entry
  // should not be materially smaller than what went in.
  it('stores rather than deflating', async () => {
    const data = new Uint8Array(2048).map((_, i) => i % 251)
    const out = await zipFiles([{ name: 'x.pdf', data }])
    expect(out.byteLength).toBeGreaterThanOrEqual(data.byteLength)
  })
})
