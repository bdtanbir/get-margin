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
