import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'

beforeEach(() => { vi.resetModules() })

describe('useShell', () => {
  it('reports desktop at and above the breakpoint', async () => {
    const { useShell, DESKTOP_MIN_PX } = await import('../../src/lib/breakpoint.js')
    window.innerWidth = DESKTOP_MIN_PX
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(useShell().isDesktop.value).toBe(true)
  })

  it('reports mobile below the breakpoint', async () => {
    const { useShell, DESKTOP_MIN_PX } = await import('../../src/lib/breakpoint.js')
    window.innerWidth = DESKTOP_MIN_PX - 1
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(useShell().isDesktop.value).toBe(false)
  })

  it('reacts to a resize across the breakpoint', async () => {
    const { useShell, DESKTOP_MIN_PX } = await import('../../src/lib/breakpoint.js')
    const shell = useShell()
    window.innerWidth = 375
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(shell.isDesktop.value).toBe(false)

    window.innerWidth = DESKTOP_MIN_PX + 200
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(shell.isDesktop.value).toBe(true)
  })
})
