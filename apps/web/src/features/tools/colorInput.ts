import type { Color } from '@margin/pdf-core'

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n * 255)))

/**
 * MuPDF colour channels (0..1) <-> the `#rrggbb` an `<input type="color">`
 * speaks. `<input type="color">` has no way to express "no colour", so a
 * null fill or stroke shows as black; a null-capable control is Phase 4's
 * problem, not something to fake with a sentinel colour here.
 */
export function toHex(c: Color | null | undefined): string {
  if (!c) return '#000000'
  return `#${c.map((n) => clamp255(n).toString(16).padStart(2, '0')).join('')}`
}

export function fromHex(hex: string): Color {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0, 0, 0]
  const n = parseInt(m[1]!, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
