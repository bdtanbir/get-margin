/**
 * URL validation for the link tool.
 *
 * Blocking `javascript:` and friends is a SECURITY requirement (spec 2.1),
 * and it is enforced here -- at op-creation time -- rather than at export,
 * so an invalid URL is unrepresentable in the edit document rather than
 * rejected late by a download that fails for reasons the user cannot see.
 */
const ALLOWED = new Set(['http:', 'https:', 'mailto:', 'tel:'])

export function normalizeUri(input: string): string {
  const raw = input.trim()
  if (!raw) throw new Error('Enter a URL.')
  // Bare domains are the common case in a UI; assume https rather than
  // letting the URL parser reject them.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error('That does not look like a valid URL.')
  }
  if (!ALLOWED.has(url.protocol.toLowerCase())) {
    throw new Error(`Links using "${url.protocol}" are not allowed.`)
  }
  return url.toString()
}

/** True when `input` would be accepted, for live form validation. */
export function isValidUri(input: string): boolean {
  try {
    normalizeUri(input)
    return true
  } catch {
    return false
  }
}

/**
 * A link needs a URL before it can exist, and the URL is validated at
 * op-creation time so an invalid one is unrepresentable (spec 2.1). The
 * prompt is injectable so tests do not depend on window.prompt, and so a
 * later task can swap it for a proper dialog without touching its callers.
 *
 * It lives beside the validation rather than in the draw tool because two
 * gestures now ask the same question -- dragging a hotspot out, and turning
 * a text selection into one -- and neither is the other's owner.
 */
export type UriPrompt = (current: string) => string | null

const defaultPrompt: UriPrompt = (current) =>
  typeof window === 'undefined' ? null : window.prompt('Link URL', current)

let prompt: UriPrompt = defaultPrompt

export function askForUri(current: string): string | null {
  return prompt(current)
}

export function setUriPrompt(fn: UriPrompt | undefined): void {
  prompt = fn ?? defaultPrompt
}
