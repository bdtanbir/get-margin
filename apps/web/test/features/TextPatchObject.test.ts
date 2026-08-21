import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { TextPatchObject } from '@margin/pdf-core'
import TextPatchObjectView from '@/features/overlay/objects/TextPatchObject.vue'

/**
 * Where the overlay draws a replacement for the document's own text.
 *
 * The invariant under test is that the PREVIEW AGREES WITH THE EXPORT, and
 * the only thing that makes it agree is the stored baseline. The writer
 * sits a replacement on the pen position it re-extracts from the page; the
 * overlay used to derive one from the box and the font size instead, which
 * is wrong by however much the font's descender differs from the constant
 * -- about 5pt on a 24pt line.
 *
 * That was survivable while the size was fixed, because the error was fixed
 * too. With the size editable it becomes a function of the size, so the
 * previewed text would climb the page as you enlarged it while the exported
 * text did not move at all.
 */
const patch = (over: Partial<TextPatchObject> = {}): TextPatchObject => ({
  id: 'x1', pageId: 'p1', kind: 'textPatch',
  lineIndex: 0, originalHash: 'abcd1234', originalText: 'Original',
  text: 'Replacement',
  fontFamily: 'Inter', fontSize: 12, baseline: 114, color: [0, 0, 0],
  background: [1, 1, 1], backgroundConfidence: 1, fit: 'overflow',
  // A line whose glyph box runs y 100..118 in page space.
  rect: { x: 40, y: 100, w: 120, h: 18 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  ...over,
})

/**
 * The same patch as it would have been stored before the baseline was
 * recorded: the key ABSENT, not present and undefined. `tsconfig` runs with
 * `exactOptionalPropertyTypes`, which is the compiler making exactly this
 * distinction -- and it is the distinction the fallback turns on, so the
 * fixture has to honour it rather than spell `baseline: undefined`.
 */
const legacyPatch = (over: Partial<TextPatchObject> = {}): TextPatchObject => {
  const { baseline: _dropped, ...rest } = patch(over)
  return rest as TextPatchObject
}

const baselineOf = (o: TextPatchObject): number =>
  Number(mount(TextPatchObjectView, { props: { object: o } }).get('text').attributes('y'))

const sizeOf = (o: TextPatchObject): number =>
  Number(mount(TextPatchObjectView, { props: { object: o } }).get('text').attributes('font-size'))

describe('TextPatchObject', () => {
  it('sits on the line’s own baseline, not one derived from the box', () => {
    // 114, the pen position -- not 100 + 12 * 0.8 = 109.6.
    expect(baselineOf(patch())).toBe(114)
  })

  it('does not move the baseline when the size changes', () => {
    // The property that matters. The export keeps the replacement on the
    // line it replaced whatever size it is set in, so the preview must too.
    expect(baselineOf(patch({ fontSize: 30 }))).toBe(baselineOf(patch({ fontSize: 8 })))
  })

  it('draws at the size the patch asks for', () => {
    expect(sizeOf(patch({ fontSize: 30 }))).toBe(30)
  })

  /**
   * Patches stored before the baseline was recorded keep the old
   * approximation. They previewed at that height yesterday, and moving them
   * today would read as a bug in whatever the user had already laid out.
   */
  it('falls back to the old approximation for a patch that has no baseline', () => {
    expect(baselineOf(legacyPatch({ fontSize: 12 }))).toBeCloseTo(100 + 12 * 0.8, 5)
  })

  it('still resolves the sentinel size for a patch that has no size', () => {
    // 0 means "the size of the line", which the overlay approximates from
    // the box because it has no extraction of its own to consult.
    expect(sizeOf(legacyPatch({ fontSize: 0 }))).toBeCloseTo(18 * 0.8, 5)
  })
})
