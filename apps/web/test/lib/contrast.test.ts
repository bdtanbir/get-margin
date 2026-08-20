import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  contrastRatio,
  oklchToRgb,
  parseOklch,
  ratioOf,
  relativeLuminance,
  toHex,
  AA_NORMAL,
  AA_NON_TEXT,
} from '@/lib/contrast'

/**
 * The stylesheet the app actually ships.
 *
 * Read off disk rather than imported. These tests run under jsdom, where
 * `import.meta.url` is not a file URL, and Vitest stubs CSS imports to an
 * empty string by default -- so `?raw` silently yields nothing, and every
 * assertion below would pass over zero tokens.
 *
 * Two candidate paths because the working directory differs between a
 * workspace run and a run inside `apps/web`. Missing is a loud failure,
 * not a skip: a contrast suite that quietly finds no tokens is worse than
 * no contrast suite.
 */
function tokensCss(): string {
  const candidates = [
    resolve(process.cwd(), 'apps/web/src/app/styles/tokens.css'),
    resolve(process.cwd(), 'src/app/styles/tokens.css'),
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) {
    throw new Error(`tokens.css not found. Looked in:\n  ${candidates.join('\n  ')}`)
  }
  return readFileSync(found, 'utf8')
}

/**
 * Not a copy of the values. A test holding its own copy would pass forever
 * after someone edited the real file, which is the failure that lets a
 * contrast regression through.
 */
function readTokens(): { light: Record<string, string>; dark: Record<string, string> } {
  const css = tokensCss()
  // The SELECTOR at the start of a line, not the first mention of the
  // string. The file's header comment names `[data-theme='dark']` while
  // explaining the theme swap, and splitting on that put every token in
  // the "dark" half -- where first-definition-wins handed back the light
  // values and the dark assertions passed against the wrong colours.
  const darkStart = css.search(/^\[data-theme='dark'\]\s*\{/m)
  expect(darkStart, 'the dark theme block moved or was renamed').toBeGreaterThan(0)

  const grab = (text: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const match of text.matchAll(/--color-([\w-]+):\s*(oklch\([^)]*\))/g)) {
      const name = match[1]
      const value = match[2]
      if (!name || !value) continue
      // First definition wins within a block; later blocks are read separately.
      if (!(name in out)) out[name] = value
    }
    return out
  }
  const light = grab(css.slice(0, darkStart))
  const dark = grab(css.slice(darkStart))

  // Guard against the split silently going wrong again. If these two maps
  // ever agree on the text colour, one half is not the half it claims.
  expect(Object.keys(light).length, 'no tokens found in the light block').toBeGreaterThan(5)
  expect(Object.keys(dark).length, 'no tokens found in the dark block').toBeGreaterThan(5)
  expect(dark['text'], 'light and dark resolved to the same tokens').not.toBe(light['text'])

  return { light, dark }
}

/** Every surface a given text token can legitimately sit on. */
const SURFACES = ['canvas', 'surface', 'surface-raised', 'surface-sunken'] as const

describe('the contrast helper itself', () => {
  /**
   * Pinned against colours a real browser painted.
   *
   * axe reported these while auditing the running app: the subtle token
   * rendered as #8f9299 on a #f4f4f6 canvas at 2.83:1. If this conversion
   * drifted from what a browser does, every assertion below would be about
   * a colour nobody sees.
   */
  it('converts oklch the way the browser does', () => {
    expect(toHex(oklchToRgb(0.66, 0.01, 265))).toBe('#8f9299')
    expect(toHex(oklchToRgb(0.968, 0.002, 265))).toBe('#f4f4f6')
    expect(toHex(oklchToRgb(1, 0, 0))).toBe('#ffffff')
  })

  it('reproduces the ratio the browser measured, to within rounding', () => {
    // axe said 2.83 for the old subtle token on canvas.
    expect(ratioOf('oklch(0.66 0.01 265)', 'oklch(0.968 0.002 265)')).toBeCloseTo(2.83, 1)
  })

  /** WCAG's own worked examples: black on white is 21:1, a colour on itself is 1:1. */
  it('agrees with WCAG on the extremes', () => {
    const black = { r: 0, g: 0, b: 0 }
    const white = { r: 255, g: 255, b: 255 }
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5)
    expect(contrastRatio(white, black)).toBeCloseTo(21, 5)
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5)
    expect(relativeLuminance(white)).toBeCloseTo(1, 5)
    expect(relativeLuminance(black)).toBeCloseTo(0, 5)
  })

  it('refuses a value it cannot parse rather than guessing', () => {
    expect(parseOklch('#ffffff')).toBeNull()
    expect(parseOklch('oklch(0.5 0.1 200)')).toEqual({ l: 0.5, c: 0.1, h: 200 })
    expect(() => ratioOf('red', 'oklch(1 0 0)')).toThrow()
  })
})

describe('every text token passes AA on every surface it can appear on', () => {
  const tokens = readTokens()

  for (const theme of ['light', 'dark'] as const) {
    for (const text of ['text', 'text-muted', 'text-subtle'] as const) {
      it(`${theme}: ${text}`, () => {
        const fg = tokens[theme][text]
        expect(fg, `${theme} --color-${text} is missing`).toBeTruthy()

        for (const surface of SURFACES) {
          const bg = tokens[theme][surface]
          expect(bg, `${theme} --color-${surface} is missing`).toBeTruthy()
          const ratio = ratioOf(fg!, bg!)
          expect(
            ratio,
            `${theme} ${text} on ${surface} is ${ratio}:1, needs ${AA_NORMAL}:1 ` +
              `(${toHex(oklchToRgb(...oklchArgs(fg!)))} on ${toHex(oklchToRgb(...oklchArgs(bg!)))})`,
          ).toBeGreaterThanOrEqual(AA_NORMAL)
        }
      })
    }
  }

  /**
   * The three steps have to stay distinguishable, or the fix for contrast
   * quietly becomes a fix that deletes the hierarchy.
   *
   * Raising `subtle` to a passing value on its own would have put it within
   * 0.005 of `muted` -- both legible, and indistinguishable from each
   * other, which is not what a three-level type scale is for.
   */
  it('keeps the three text levels visibly apart', () => {
    for (const theme of ['light', 'dark'] as const) {
      const l = (name: string) => parseOklch(tokens[theme][name]!)!.l
      const steps = [l('text'), l('text-muted'), l('text-subtle')]
      const gaps = [Math.abs(steps[1]! - steps[0]!), Math.abs(steps[2]! - steps[1]!)]
      for (const gap of gaps) {
        expect(gap, `${theme} steps ${steps.join(' -> ')} are too close`).toBeGreaterThan(0.05)
      }
      // And they stay ordered: text is the strongest, subtle the weakest.
      const ordered = theme === 'light' ? steps[0]! < steps[1]! && steps[1]! < steps[2]!
        : steps[0]! > steps[1]! && steps[1]! > steps[2]!
      expect(ordered, `${theme} text ramp is out of order: ${steps.join(' -> ')}`).toBe(true)
    }
  })
})

describe('interface colours', () => {
  const tokens = readTokens()

  /**
   * Indicators, at AA's non-text threshold of 3:1.
   *
   * WCAG 1.4.11 covers "visual information required to identify user
   * interface components and states" -- the focus ring, and the accent
   * ring that marks a selected thumbnail. Both carry meaning that is not
   * available any other way.
   *
   * `border-strong` is deliberately NOT here, at 1.53:1. It is used once,
   * as a hover ring on a thumbnail, and hover is not a state anyone
   * depends on: selection is shown with the accent ring, and the thumbnail
   * is identified by the page it displays. Holding a decorative hover
   * affordance to an indicator's standard would mean either a wrong test
   * or a darker border nobody asked for.
   */
  it('focus and selection indicators reach the non-text threshold', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const [name, surface] of [
        ['focus', 'surface'],
        ['focus', 'canvas'],
        ['accent', 'surface'],
        ['accent', 'canvas'],
      ] as const) {
        const ratio = ratioOf(tokens[theme][name]!, tokens[theme][surface]!)
        expect(ratio, `${theme} ${name} on ${surface} is ${ratio}:1`).toBeGreaterThanOrEqual(
          AA_NON_TEXT,
        )
      }
    }
  })

  /** Text on a filled button is the pairing nobody thinks to check. */
  it('accent and danger text reads on its own fill', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const [fg, bg] of [
        ['accent-fg', 'accent'],
        ['danger-fg', 'danger'],
      ] as const) {
        const ratio = ratioOf(tokens[theme][fg]!, tokens[theme][bg]!)
        expect(ratio, `${theme} ${fg} on ${bg} is ${ratio}:1`).toBeGreaterThanOrEqual(AA_NORMAL)
      }
    }
  })
})

function oklchArgs(value: string): [number, number, number] {
  const p = parseOklch(value)!
  return [p.l, p.c, p.h]
}
