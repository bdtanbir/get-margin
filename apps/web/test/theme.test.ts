import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resolveTheme, THEME_STORAGE_KEY } from '../src/lib/theme.js'

describe('resolveTheme', () => {
  it('passes explicit choices straight through', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('follows the system preference when the choice is system', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('dark'),
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  })

  it('defaults to system and reflects the media query', async () => {
    const { useTheme } = await import('../src/lib/theme.js')
    const t = useTheme()
    expect(t.choice.value).toBe('system')
    expect(t.resolved.value).toBe('dark')
  })

  it('writes the resolved theme to the root element', async () => {
    const { useTheme } = await import('../src/lib/theme.js')
    const t = useTheme()
    t.setChoice('light')
    await Promise.resolve()
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('persists the choice, not the resolved value', async () => {
    const { useTheme } = await import('../src/lib/theme.js')
    useTheme().setChoice('system')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
  })

  it('cycles light to dark to system', async () => {
    const { useTheme } = await import('../src/lib/theme.js')
    const t = useTheme()
    t.setChoice('light')
    t.cycle(); expect(t.choice.value).toBe('dark')
    t.cycle(); expect(t.choice.value).toBe('system')
    t.cycle(); expect(t.choice.value).toBe('light')
  })

  it('ignores a corrupt stored value', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'chartreuse')
    vi.resetModules()
    const { useTheme } = await import('../src/lib/theme.js')
    expect(useTheme().choice.value).toBe('system')
  })
})
