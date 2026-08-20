/**
 * WCAG contrast, computed from the design tokens themselves.
 *
 * The tokens are authored in oklch, which is perceptually uniform and
 * pleasant to tune -- and gives no hint whatsoever about whether a pair
 * passes AA, because WCAG's ratio is defined on sRGB relative luminance.
 * `oklch(0.66 ...)` looks like it should be comfortably mid-range; it
 * measures 2.83:1 on a near-white surface.
 *
 * So this converts the way the browser does and applies WCAG's own
 * formula, which lets a unit test report "text-subtle on surface-sunken is
 * 2.83:1, needs 4.5:1" instead of an end-to-end tool reporting that
 * something, somewhere, is too light.
 */

export type Rgb = { r: number; g: number; b: number }

/** AA for body text. Large text is 3:1, which this codebase does not rely on. */
export const AA_NORMAL = 4.5
/** AA for text at or above 18.66px bold / 24px regular. */
export const AA_LARGE = 3
/** AA for interface components and graphical objects -- borders, focus rings. */
export const AA_NON_TEXT = 3

/** `oklch(0.66 0.01 265)` -> its three numbers. Returns null for anything else. */
export function parseOklch(value: string): { l: number; c: number; h: number } | null {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value.trim())
  if (!match) return null
  return { l: Number(match[1]), c: Number(match[2]), h: Number(match[3]) }
}

/**
 * oklch to sRGB, via oklab and linear sRGB.
 *
 * The matrices are Björn Ottosson's published oklab constants -- the same
 * ones every browser implements, which is what makes the output comparable
 * to what a browser actually paints. The test pins this against colours
 * read out of a real rendered page rather than trusting the arithmetic.
 */
export function oklchToRgb(l: number, c: number, h: number): Rgb {
  const rad = (h * Math.PI) / 180
  const a = c * Math.cos(rad)
  const bb = c * Math.sin(rad)

  const lp = l + 0.3963377774 * a + 0.2158037573 * bb
  const mp = l - 0.1055613458 * a - 0.0638541728 * bb
  const sp = l - 0.0894841775 * a - 1.291485548 * bb

  const L = lp * lp * lp
  const M = mp * mp * mp
  const S = sp * sp * sp

  return {
    r: toByte(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
    g: toByte(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
    b: toByte(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S),
  }
}

/** Linear light to an 8-bit sRGB channel, with the standard transfer curve. */
function toByte(linear: number): number {
  const clamped = Math.min(1, Math.max(0, linear))
  const encoded =
    clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055
  return Math.round(encoded * 255)
}

export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** WCAG 2.x relative luminance. Note this is NOT oklch's L, and differs sharply from it. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** 1 to 21. Order-independent, as WCAG defines it. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** The ratio for two oklch token values, rounded the way a report should read. */
export function ratioOf(foreground: string, background: string): number {
  const f = parseOklch(foreground)
  const b = parseOklch(background)
  if (!f || !b) throw new Error(`not an oklch pair: ${foreground} / ${background}`)
  const ratio = contrastRatio(oklchToRgb(f.l, f.c, f.h), oklchToRgb(b.l, b.c, b.h))
  // Two decimals: the number appears in failure messages and in the
  // findings, and more precision there is noise.
  return Math.round(ratio * 100) / 100
}
