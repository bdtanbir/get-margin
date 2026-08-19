import type { Color } from '@margin/pdf-core'

/** `[0.2,0.4,1]` (MuPDF's 0..1 range) -> `rgb(51,102,255)` for CSS/SVG. */
export function rgb(c: Color | null | undefined): string {
  return c ? `rgb(${c.map((n) => Math.round(n * 255)).join(',')})` : 'none'
}

/** A null fill means genuinely unfilled, which SVG spells `none`. */
export const svgFill = rgb
export const svgStroke = rgb
