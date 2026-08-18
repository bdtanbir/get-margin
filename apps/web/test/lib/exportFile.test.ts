import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { downloadBytes } from '@/lib/exportFile'

describe('downloadBytes', () => {
  let createdUrl: string
  let revoked: string[]

  beforeEach(() => {
    createdUrl = 'blob:mock-url'
    revoked = []
    URL.createObjectURL = vi.fn(() => createdUrl)
    URL.revokeObjectURL = vi.fn((u: string) => void revoked.push(u))
  })

  afterEach(() => vi.restoreAllMocks())

  it('clicks an anchor carrying the given file name', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    downloadBytes(new Uint8Array([1, 2, 3]), 'report.pdf')
    expect(click).toHaveBeenCalledTimes(1)
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement
    expect(anchor.download).toBe('report.pdf')
    expect(anchor.href).toContain(createdUrl)
  })

  it('revokes the object URL so the blob is not retained', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    downloadBytes(new Uint8Array([1]), 'a.pdf')
    expect(revoked).toEqual([createdUrl])
  })

  it('leaves no anchor behind in the document', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    downloadBytes(new Uint8Array([1]), 'a.pdf')
    expect(document.querySelectorAll('a[download]')).toHaveLength(0)
  })
})
