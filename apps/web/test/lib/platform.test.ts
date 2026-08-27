import { describe, it, expect } from 'vitest'
import { shortcutLabel, USES_COMMAND_KEY } from '@/lib/platform'
import { shortcut } from '@/features/help/shortcuts'

describe('shortcutLabel', () => {
  /**
   * jsdom reports no Apple platform, so this suite runs the Ctrl branch.
   * Asserted rather than assumed: if the detection ever defaulted the other
   * way, every expectation below would silently invert.
   */
  it('runs against the non-Apple branch under jsdom', () => {
    expect(USES_COMMAND_KEY).toBe(false)
  })

  it('rewrites the command glyph the shortcut table stores', () => {
    expect(shortcutLabel('⌘K')).toBe('Ctrl K')
  })

  it('rewrites a multi-modifier combination', () => {
    expect(shortcutLabel('⇧⌘Z')).toBe('Shift Ctrl Z')
  })

  it('leaves a combination with no modifier glyph alone', () => {
    expect(shortcutLabel('Esc')).toBe('Esc')
    expect(shortcutLabel('Delete')).toBe('Delete')
  })

  /**
   * Reads the real entry rather than a copied string, so the chip in the top
   * bar and the row in the help panel cannot come to describe different keys.
   */
  it('renders the palette shortcut the catalogue declares', () => {
    expect(shortcutLabel(shortcut('palette').display)).toBe('Ctrl K')
  })
})
