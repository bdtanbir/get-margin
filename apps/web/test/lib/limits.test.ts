import { describe, it, expect } from 'vitest'
import { checkFileSize, checkPageCount, MAX_BYTES, MAX_PAGES } from '../../src/lib/limits.js'

describe('checkFileSize', () => {
  it('accepts a file at the limit', () => {
    expect(checkFileSize(MAX_BYTES)).toEqual({ ok: true })
  })

  it('rejects a file over the limit with a human-readable size', () => {
    const v = checkFileSize(MAX_BYTES + 1)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reason).toBe('too-large')
      expect(v.message).toMatch(/150 MB/)
    }
  })

  it('rejects an empty file', () => {
    expect(checkFileSize(0).ok).toBe(false)
  })
})

describe('checkPageCount', () => {
  it('accepts a document at the limit', () => {
    expect(checkPageCount(MAX_PAGES)).toEqual({ ok: true })
  })

  it('rejects too many pages', () => {
    const v = checkPageCount(MAX_PAGES + 1)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('too-many-pages')
  })
})
