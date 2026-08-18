import { describe, it, expect } from 'vitest'

describe('workspace', () => {
  it('loads the mupdf module', async () => {
    const mupdf = await import('mupdf')
    expect(mupdf).toBeDefined()
    expect(typeof mupdf.Document?.openDocument).toBe('function')
  })
})
