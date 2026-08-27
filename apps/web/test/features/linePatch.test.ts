import { describe, it, expect } from 'vitest'
import { isPristine } from '@/features/patch/linePatch'
import type { Color, LineRun, TextPatchObject } from '@margin/pdf-core'

const line: LineRun = {
  bbox: [10, 100, 30, 120],
  text: 'ab',
  font: 'Helvetica',
  bold: false,
  italic: false,
  color: [0, 0, 0] as Color,
  size: 10,
  baseline: 116,
  chars: [...'ab'].map((char, i) => ({
    char,
    quad: [10 + i * 10, 100, 20 + i * 10, 100, 10 + i * 10, 120, 20 + i * 10, 120],
  })),
} as unknown as LineRun

const patch = (over: Partial<TextPatchObject> = {}): TextPatchObject => ({
  id: 'p1', pageId: 'pg1', kind: 'textPatch',
  lineIndex: 0, originalHash: 'h', originalText: 'ab',
  text: 'ab',
  fontFamily: 'Inter', bold: false, italic: false, fontSize: 10, baseline: 116,
  color: [0, 0, 0], background: [1, 1, 1], backgroundConfidence: 1, fit: 'overflow',
  rect: { x: 10, y: 100, w: 20, h: 20 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  ...over,
})

/**
 * A pristine patch is one worth deleting: it paints a cover over a line and
 * redraws it identically, achieving nothing visible while leaving a scar
 * wherever the background is not flat. `SelectionToolbar` deletes them.
 */
describe('isPristine', () => {
  it('is true for a patch that draws exactly what the document draws', () => {
    expect(isPristine(patch(), line)).toBe(true)
  })

  it('is false once the text differs', () => {
    expect(isPristine(patch({ text: 'cd' }), line)).toBe(false)
  })

  it('is false once the style differs', () => {
    expect(isPristine(patch({ bold: true }), line)).toBe(false)
  })

  /**
   * THE TRAP THIS PINS. A pure move changes neither the words nor the
   * style, so a pristine check that looks only at those two calls a moved
   * patch a no-op -- and the toolbar deletes it. Toggling Bold on and off
   * over a line the user had dragged would silently put it back, with the
   * move gone from the document and from the undo history's account of it.
   */
  it('is false once the patch has been moved, however unchanged the words are', () => {
    expect(isPristine(patch({ offset: { dx: 20, dy: 0 } }), line)).toBe(false)
    expect(isPristine(patch({ offset: { dx: 0, dy: 20 } }), line)).toBe(false)
  })

  it('is still true for an offset that moves nothing', () => {
    expect(isPristine(patch({ offset: { dx: 0, dy: 0 } }), line)).toBe(true)
  })
})
