import { describe, it, expect } from 'vitest'
import { checkFileSize, checkPageCount, MAX_BYTES, MAX_PAGES, checkTotalOpenSize, MAX_TOTAL_SOURCE_BYTES } from '../../src/lib/limits.js'

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

// MAX_BYTES bounds one file; nothing bounded the sum, so merging several
// large documents grew memory without limit.
describe('checkTotalOpenSize', () => {
  it('allows a merge that stays inside the total budget', () => {
    expect(checkTotalOpenSize(10 * 1024 * 1024, 10 * 1024 * 1024).ok).toBe(true)
  })

  it('allows a merge that lands exactly on the limit', () => {
    expect(checkTotalOpenSize(MAX_TOTAL_SOURCE_BYTES - 1024, 1024).ok).toBe(true)
  })

  it('refuses a merge that would cross it', () => {
    const verdict = checkTotalOpenSize(MAX_TOTAL_SOURCE_BYTES, 1)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe('too-much-open')
  })

  // Refusing without saying what to do next is half an answer.
  it('says what to do about it', () => {
    const verdict = checkTotalOpenSize(MAX_TOTAL_SOURCE_BYTES, 1)
    if (!verdict.ok) {
      expect(verdict.message).toContain('Export what you have')
      expect(verdict.message).toContain('300 MB')
    }
  })

  it('leaves a single large file to checkFileSize rather than double-refusing', () => {
    // 150MB is the per-file cap and well inside the 300MB total.
    expect(checkTotalOpenSize(0, MAX_BYTES).ok).toBe(true)
  })
})
