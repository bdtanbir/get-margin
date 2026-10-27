import { describe, it, expect, beforeEach } from 'vitest'
import {
  familyForLine, fontKey, forgetReplacements, needsReplacementChoice,
  rememberReplacement, similarFonts, SUGGESTION_COUNT,
} from '@/lib/fontMatch'
import { FONTS } from '@/lib/fonts'

const carried = new Set(FONTS.map((f) => f.family))
const families = (name: string) => similarFonts(name).map((s) => s.family)

describe('similarFonts', () => {
  it('offers the metric-compatible stand-in first, marked very similar', () => {
    for (const [name, first] of [
      ['BCDFEE+Cambria-Bold', 'Caladea'],
      ['Calibri', 'Carlito'],
      ['Helvetica-Bold', 'Arimo'],
      ['Times-Roman', 'Tinos'],
      ['Courier', 'Cousine'],
    ] as const) {
      const [top] = similarFonts(name)
      expect(top, name).toEqual({ family: first, verySimilar: true })
    }
  })

  it('offers five distinct faces we carry, never Inter for a serif', () => {
    const list = families('BCDFEE+Cambria-Bold')
    expect(list).toHaveLength(SUGGESTION_COUNT)
    expect(new Set(list).size).toBe(list.length)
    for (const f of list) expect(carried.has(f), f).toBe(true)
    expect(list).not.toContain('Inter')
  })

  it('reads the kind of face off an unknown name', () => {
    expect(families('XYZWQE+FancyOldStyleSerif-Regular')[0]).toBe('Tinos')
    expect(families('AcmeSans-Bold')[0]).toBe('Arimo')
    expect(families('AcmeMono')[0]).toBe('Cousine')
  })

  it('takes the longest known name', () => {
    expect(families('NotoSerif-Regular')[0]).toBe('Roboto Serif')
    expect(families('NotoSans-Regular')[0]).toBe('Roboto')
  })
})

describe('remembered replacements', () => {
  beforeEach(() => forgetReplacements())

  it('keys by family, ignoring subset tag and style', () => {
    expect(fontKey('BCDFEE+Cambria-Bold')).toBe(fontKey('ABCDEF+Cambria'))
    expect(fontKey('Cambria,Italic')).toBe('cambria')
  })

  it('asks only for a font we do not carry and have no choice for', () => {
    expect(needsReplacementChoice('ABCDEF+Outfit-Regular')).toBe(false)
    expect(needsReplacementChoice('Inter-Bold')).toBe(false)
    expect(needsReplacementChoice('BCDFEE+Constantia-Bold')).toBe(true)
    rememberReplacement('BCDFEE+Constantia-Bold', 'Lora')
    expect(needsReplacementChoice('ABCDEF+Constantia')).toBe(false)
    expect(familyForLine('ABCDEF+Constantia')).toBe('Lora')
  })

  it('does not ask when we carry a metric-compatible twin', () => {
    for (const [name, twin] of [
      ['BCDFEE+Cambria-Bold', 'Caladea'],
      ['Calibri-Bold', 'Carlito'],
      ['Times-Roman', 'Tinos'],
      ['TimesNewRomanPS-BoldMT', 'Tinos'],
      ['Helvetica', 'Arimo'],
    ] as const) {
      expect(needsReplacementChoice(name), name).toBe(false)
      expect(familyForLine(name), name).toBe(twin)
    }
  })

  it('still asks for a placeholder name with nothing to go on', () => {
    expect(needsReplacementChoice('CIDFont+F4')).toBe(true)
  })

  it('falls back to the closest face, not Inter, when it cannot ask', () => {
    expect(familyForLine('BCDFEE+Cambria-Bold')).toBe('Caladea')
    expect(familyForLine('ABCDEF+Outfit-Regular')).toBe('Outfit')
  })
})
