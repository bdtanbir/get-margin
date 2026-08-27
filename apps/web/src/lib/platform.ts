/**
 * Which modifier this machine's users actually press.
 *
 * `shortcuts.ts` stores Mac glyphs, and the help panel prints them with a
 * footnote saying to read ⌘ as Ctrl elsewhere. A footnote is fine in a table
 * someone is reading top to bottom; it does not work for a chip sitting in
 * the toolbar all day, whose whole job is to teach one key combination at a
 * glance. Showing "⌘K" to a Windows user there teaches the wrong key.
 *
 * `navigator.platform` is deprecated but is still the only synchronous
 * signal every engine agrees on. `userAgentData.platform` is Chromium-only,
 * so it is tried first and fallen back from rather than depended on.
 *
 * Defaults to the Ctrl form when nothing can be determined, including under
 * SSR and in jsdom: Ctrl is correct for most users, and the failure mode of
 * guessing wrong in that direction is a Mac user reading "Ctrl K" -- which
 * the app also accepts, because every binding takes both.
 */
function detectApple(): boolean {
  if (typeof navigator === 'undefined') return false

  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData
  const platform = data?.platform ?? navigator.platform ?? ''
  // iPadOS reports "MacIntel", which is the answer we want anyway: an
  // attached keyboard on an iPad carries a Command key.
  return /mac|iphone|ipad|ipod/i.test(platform)
}

/**
 * Resolved once, at module load. The platform cannot change under a running
 * tab, and re-sniffing per render would put a deprecated API in a hot path.
 */
export const USES_COMMAND_KEY = detectApple()

/**
 * A shortcut's display string, in the modifiers this machine uses.
 *
 * Rewrites the glyphs `shortcuts.ts` stores rather than holding a second
 * table of key names: two tables is how the help panel and a toolbar chip
 * get to disagree about which key opens the palette.
 */
export function shortcutLabel(display: string): string {
  if (USES_COMMAND_KEY) return display
  return display
    .replace(/⌘/g, 'Ctrl ')
    .replace(/⇧/g, 'Shift ')
    .replace(/⌥/g, 'Alt ')
    .trim()
}
