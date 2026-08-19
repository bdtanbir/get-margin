import { describe, it, expect } from 'vitest'
import { normalizeUri, isValidUri } from '@/lib/linkUrl'

describe('normalizeUri', () => {
  it('accepts http and https', () => {
    expect(normalizeUri('https://example.com')).toBe('https://example.com/')
    expect(normalizeUri('http://example.com/a')).toBe('http://example.com/a')
  })

  it('adds https:// to a bare domain', () => {
    expect(normalizeUri('example.com/a')).toBe('https://example.com/a')
  })

  it('accepts mailto: and tel:', () => {
    expect(normalizeUri('mailto:a@b.com')).toBe('mailto:a@b.com')
    expect(normalizeUri('tel:+15551234')).toBe('tel:+15551234')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeUri('  https://example.com  ')).toBe('https://example.com/')
  })

  // Blocking javascript: is a security requirement (spec 2.1), enforced at
  // op-creation time so an invalid link can never reach the export path.
  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:x',
    'data:text/html,x',
    'vbscript:x',
    'file:///etc/passwd',
  ])('rejects %s', (bad) => {
    expect(() => normalizeUri(bad)).toThrow(/not allowed/i)
  })

  it('rejects unparseable input', () => {
    expect(() => normalizeUri('http://')).toThrow()
  })

  it('rejects an empty string with an actionable message', () => {
    expect(() => normalizeUri('   ')).toThrow(/Enter a URL/)
  })
})

describe('isValidUri', () => {
  it('mirrors normalizeUri without throwing', () => {
    expect(isValidUri('example.com')).toBe(true)
    expect(isValidUri('javascript:x')).toBe(false)
    expect(isValidUri('')).toBe(false)
  })
})
