import { describe, it, expect } from 'vitest'
import {
  buildLinePatch, documentStyle, isPristine, stripAxes,
} from '@/features/patch/linePatch'
import { patchFor, fieldsFor } from '@/features/tools/inspectorFields'
import type { Color, LineRun, TextPatchObject } from '@margin/pdf-core'

/** "Hi **Arafat** 14th": a bold name and a raised, smaller "th". */
const style = { font: 'Inter-Regular', italic: false, size: 12, color: [0, 0, 0] as Color, rise: 0 }
const text = 'Hi Arafat 14th'
const line: LineRun = {
  bbox: [10, 100, 150, 114], text, font: 'Inter-Regular', weight: 400, italic: false,
  color: [0, 0, 0], size: 12, baseline: 111,
  chars: [...text].map((char, i) => ({
    char, quad: [10 + i * 10, 100, 20 + i * 10, 100, 10 + i * 10, 114, 20 + i * 10, 114],
  })),
  spans: [
    { ...style, text: 'Hi ', weight: 400 },
    { ...style, text: 'Arafat', weight: 700 },
    { ...style, text: ' 14', weight: 400 },
    { ...style, text: 'th', weight: 400, size: 8, rise: 4 },
  ],
}

const build = (over: Partial<Parameters<typeof buildLinePatch>[0]> = {}): TextPatchObject =>
  buildLinePatch({
    pageId: 'p1', lineIndex: 0, line, fontFamily: 'Inter',
    style: documentStyle(line, 'Inter'), background: undefined, z: 1, ...over,
  })

describe('patches over a line in more than one style', () => {
  it('inherit the line\'s pieces', () => {
    expect(build().spans).toEqual([
      { text: 'Hi ' }, { text: 'Arafat', weight: 700 }, { text: ' 14' },
      { text: 'th', scale: 0.667, rise: 0.333 },
    ])
  })

  it('drop an axis the whole line was changed on -- Bold over the line bolds every word', () => {
    const patch = build({ style: { ...documentStyle(line, 'Inter'), weight: 700 } })
    expect(patch.weight).toBe(700)
    // The superscript is still a superscript; only the weights went.
    expect(patch.spans).toEqual([{ text: 'Hi Arafat 14' }, { text: 'th', scale: 0.667, rise: 0.333 }])
  })

  it('are pristine when they draw what the document draws, and not when a piece changed', () => {
    const patch = build()
    expect(isPristine(patch, line)).toBe(true)
    expect(isPristine({ ...patch, spans: stripAxes(patch.spans, ['weight']) }, line)).toBe(false)
  })

  it('lose their pieces\' weights when the inspector sets the line\'s weight', () => {
    const patch = build()
    const field = fieldsFor(patch).find((f) => f.key === 'weight')!
    const change = patchFor(patch, field, '700')
    expect(change.weight).toBe(700)
    expect(change.spans).toEqual([{ text: 'Hi Arafat 14' }, { text: 'th', scale: 0.667, rise: 0.333 }])
  })

  it('keep their pieces when the inspector changes the size, which they scale with', () => {
    const patch = build()
    const field = fieldsFor(patch).find((f) => f.key === 'fontSize')!
    expect(patchFor(patch, field, 15)).toEqual({ fontSize: 15 })
  })
})
